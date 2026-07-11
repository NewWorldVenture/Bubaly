// Household Digital Twin — the cross-domain projector (pure, unit-tested, DB-free).
//
// The twin's decision *simulator* already exists (lib/twin/simulate.ts). This is
// the other half the vision asks for: a continuously-updated, LINKED model of the
// whole household — people, pets, vehicles, schools, teams, routines, places,
// accounts — as one graph. This module turns a snapshot of the family's real
// domain rows into knowledge-graph entities + edges. The server action reads the
// live tables and upserts the output into graph_entities/graph_edges, so the twin
// stays in sync with reality. Deterministic + stable keys => idempotent upserts.

import type { EntityKind } from '@/lib/graph/reason';

export type DomainMember = { id: string; name: string | null };
export type DomainPet = { id: string; name: string | null; species?: string | null };
export type DomainVehicle = { id: string; label: string | null; primary_driver?: string | null };
export type DomainClass = { id: string; member_id: string | null; subject: string | null };
export type DomainTeam = { id: string; member_id: string | null; sport: string | null };
export type DomainRoutine = { id: string; member_id: string | null; title: string | null };
export type DomainPlace = { id: string; name: string | null };
export type DomainAccount = { id: string; name: string | null };
export type DomainProvider = { id: string; member_id: string | null; name: string | null; specialty?: string | null };

export type TwinSnapshot = {
  members: DomainMember[];
  pets: DomainPet[];
  vehicles: DomainVehicle[];
  classes: DomainClass[];
  teams: DomainTeam[];
  routines: DomainRoutine[];
  places: DomainPlace[];
  accounts: DomainAccount[];
  providers: DomainProvider[];
};

/** A projected node — `key` = `${refTable}:${refId}`, its stable identity. */
export type ProjectedEntity = { key: string; kind: EntityKind; name: string; refTable: string; refId: string };
/** A projected edge referencing entity keys (resolved to ids at write time). */
export type ProjectedEdge = { sourceKey: string; targetKey: string; relation: string; weight: number };
export type TwinProjection = { entities: ProjectedEntity[]; edges: ProjectedEdge[] };

export const EMPTY_SNAPSHOT: TwinSnapshot = {
  members: [], pets: [], vehicles: [], classes: [], teams: [], routines: [], places: [], accounts: [], providers: [],
};

const key = (table: string, id: string) => `${table}:${id}`;
const clean = (s: string | null | undefined, fallback: string) => {
  const t = (s ?? '').trim();
  return t.length ? t : fallback;
};

/**
 * Project a live household snapshot into a linked graph. People are the hubs;
 * their schools/teams/routines/pets/vehicles hang off them, and family-level
 * assets (places, accounts) become nodes too. Only edges with a resolvable
 * member endpoint are emitted (no dangling links).
 */
export function projectTwin(snap: TwinSnapshot): TwinProjection {
  const entities = new Map<string, ProjectedEntity>();
  const edges: ProjectedEdge[] = [];
  const add = (e: ProjectedEntity) => { entities.set(e.key, e); };
  const memberKeys = new Set(snap.members.map((m) => key('family_members', m.id)));

  for (const m of snap.members) {
    add({ key: key('family_members', m.id), kind: 'person', name: clean(m.name, 'Member'), refTable: 'family_members', refId: m.id });
  }
  for (const p of snap.pets) {
    add({ key: key('pets', p.id), kind: 'pet', name: clean(p.name, clean(p.species, 'Pet')), refTable: 'pets', refId: p.id });
    // pets are family-level; no reliable owner column, so no member edge.
  }
  for (const v of snap.vehicles) {
    const k = key('vehicles', v.id);
    add({ key: k, kind: 'item', name: clean(v.label, 'Vehicle'), refTable: 'vehicles', refId: v.id });
    const driverKey = v.primary_driver ? key('family_members', v.primary_driver) : null;
    if (driverKey && memberKeys.has(driverKey)) edges.push({ sourceKey: driverKey, targetKey: k, relation: 'drives', weight: 0.6 });
  }
  for (const c of snap.classes) {
    const k = key('school_classes', c.id);
    add({ key: k, kind: 'org', name: clean(c.subject, 'Class'), refTable: 'school_classes', refId: c.id });
    const mk = c.member_id ? key('family_members', c.member_id) : null;
    if (mk && memberKeys.has(mk)) edges.push({ sourceKey: mk, targetKey: k, relation: 'attends', weight: 0.7 });
  }
  for (const t of snap.teams) {
    const k = key('teams', t.id);
    add({ key: k, kind: 'activity', name: clean(t.sport, 'Team'), refTable: 'teams', refId: t.id });
    const mk = t.member_id ? key('family_members', t.member_id) : null;
    if (mk && memberKeys.has(mk)) edges.push({ sourceKey: mk, targetKey: k, relation: 'plays', weight: 0.8 });
  }
  for (const r of snap.routines) {
    const k = key('family_routines', r.id);
    add({ key: k, kind: 'event', name: clean(r.title, 'Routine'), refTable: 'family_routines', refId: r.id });
    const mk = r.member_id ? key('family_members', r.member_id) : null;
    if (mk && memberKeys.has(mk)) edges.push({ sourceKey: mk, targetKey: k, relation: 'does', weight: 0.5 });
  }
  for (const pl of snap.places) {
    add({ key: key('family_places', pl.id), kind: 'place', name: clean(pl.name, 'Place'), refTable: 'family_places', refId: pl.id });
  }
  for (const a of snap.accounts) {
    add({ key: key('financial_accounts', a.id), kind: 'item', name: clean(a.name, 'Account'), refTable: 'financial_accounts', refId: a.id });
  }
  // Care providers (doctors / dentists / specialists) — an `org` node the member
  // "sees", so the graph can reason over health relationships (Emma → Dr. Lee).
  for (const p of snap.providers) {
    const k = key('health_providers', p.id);
    const spec = clean(p.specialty, '');
    const name = clean(p.name, 'Provider');
    add({ key: k, kind: 'org', name: spec ? `${name} (${spec})` : name, refTable: 'health_providers', refId: p.id });
    const mk = p.member_id ? key('family_members', p.member_id) : null;
    if (mk && memberKeys.has(mk)) edges.push({ sourceKey: mk, targetKey: k, relation: 'sees', weight: 0.6 });
  }

  // Drop any edge whose endpoints aren't both present (defensive).
  const safeEdges = edges.filter((e) => entities.has(e.sourceKey) && entities.has(e.targetKey));
  return { entities: [...entities.values()], edges: safeEdges };
}

/** Small summary for the UI ("linked N people, M activities…"). */
export function projectionSummary(p: TwinProjection): { entities: number; edges: number; byKind: Record<string, number> } {
  const byKind: Record<string, number> = {};
  for (const e of p.entities) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return { entities: p.entities.length, edges: p.edges.length, byKind };
}
