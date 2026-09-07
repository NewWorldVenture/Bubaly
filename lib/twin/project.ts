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

// ── M3 extension: the four kinds the household actually runs on ──────────────
// Events, assets, obligations and preferences were the graph's blind spots: the
// twin knew *who* the family is but not *what is coming*, *what they own*, *what
// they owe* or *what they like*. These slices close that. Column names mirror the
// migrations exactly (verified against supabase/migrations) so a rename breaks
// the type, not production.
export type DomainEvent = {
  id: string; title: string | null; starts_at: string | null; ends_at?: string | null;
  all_day?: boolean | null; category?: string | null; location?: string | null; assignee_id?: string | null;
};
export type DomainHome = { id: string; name: string | null };
export type DomainStorageLocation = { id: string; name: string | null; kind?: string | null };
export type DomainHomeAsset = {
  id: string; name: string | null; category?: string | null; home_id?: string | null;
  location?: string | null; warranty_until?: string | null;
};
export type DomainInventoryItem = {
  id: string; name: string | null; category?: string | null; location_id?: string | null;
  owner_member_id?: string | null; status?: string | null; value_cents?: number | null;
};
export type DomainWarranty = {
  id: string; name: string | null; provider?: string | null; asset_id?: string | null;
  home_id?: string | null; expires_on?: string | null; status?: string | null;
};
export type DomainHomeProject = {
  id: string; title: string | null; status?: string | null; room?: string | null;
  owner_id?: string | null; priority?: string | null;
};
export type DomainBill = {
  id: string; name: string | null; amount?: number | null; due_date?: string | null;
  status?: string | null; category?: string | null;
};
export type DomainPaperwork = {
  id: string; title: string | null; status?: string | null; due_on?: string | null;
  amount?: number | null; kind?: string | null; actions?: unknown;
};
export type DomainRenewal = {
  id: string; title: string | null; member_id?: string | null; expires_at?: string | null;
  cost?: number | null; category?: string | null; status?: string | null;
};
export type DomainPreference = {
  id: string; member_id: string | null; label: string | null; value: string | null;
  source?: string | null; confidence?: number | null;
};

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
  // Optional so every existing caller (and every existing test) still type-checks;
  // the server loader fills them all.
  events?: DomainEvent[];
  homes?: DomainHome[];
  storageLocations?: DomainStorageLocation[];
  homeAssets?: DomainHomeAsset[];
  inventory?: DomainInventoryItem[];
  warranties?: DomainWarranty[];
  projects?: DomainHomeProject[];
  bills?: DomainBill[];
  paperwork?: DomainPaperwork[];
  renewals?: DomainRenewal[];
  preferences?: DomainPreference[];
};

/**
 * Where a projected node came from. `graph_entities` has no source/confidence/
 * observed_at columns (0129) and adding them needs a migration, so provenance
 * rides in the `attributes` jsonb instead. Every projected node carries one —
 * that is what lets a reader tell "Bubaly derived this from your calendar" from
 * "somebody typed this in".
 */
export type ProjectionProvenance = { source: 'projection'; observed_at: string; ref_table: string };

/** A projected node — `key` = `${refTable}:${refId}`, its stable identity. */
export type ProjectedEntity = {
  key: string; kind: EntityKind; name: string; refTable: string; refId: string;
  /** Always populated by `projectTwin`; optional on the type so literals in tests stay short. */
  attributes?: Record<string, unknown> & { provenance?: ProjectionProvenance };
};
/** A projected edge referencing entity keys (resolved to ids at write time). */
export type ProjectedEdge = { sourceKey: string; targetKey: string; relation: string; weight: number };
export type TwinProjection = { entities: ProjectedEntity[]; edges: ProjectedEdge[] };

export const EMPTY_SNAPSHOT: TwinSnapshot = {
  members: [], pets: [], vehicles: [], classes: [], teams: [], routines: [], places: [], accounts: [], providers: [],
  events: [], homes: [], storageLocations: [], homeAssets: [], inventory: [], warranties: [], projects: [],
  bills: [], paperwork: [], renewals: [], preferences: [],
};

/** How far ahead the calendar is projected. Beyond this a node would be noise. */
export const EVENT_HORIZON_DAYS = 60;

/** The `[from, to)` ISO window the event projection reads. Pure, so the query is testable. */
export function eventWindow(now: Date = new Date(), days: number = EVENT_HORIZON_DAYS): { from: string; to: string } {
  return { from: now.toISOString(), to: new Date(now.getTime() + days * 86_400_000).toISOString() };
}

/**
 * The `ref_table` values this projector owns. A `graph_entities` row pointing at
 * one of these, stamped `provenance.source === 'projection'`, is the projector's
 * to keep current — and to remove once its source row is gone. Anything else
 * (a manual node, a NULL ref) is never touched by the prune.
 */
export const PROJECTED_REF_TABLES = [
  'family_members', 'pets', 'vehicles', 'school_classes', 'teams', 'family_routines',
  'family_places', 'financial_accounts', 'health_providers',
  'calendar_events', 'homes', 'home_locations', 'home_assets', 'inventory_items',
  'home_warranties', 'home_projects', 'bills', 'paperwork_items', 'renewals', 'family_facts',
] as const;

const PROJECTED_REF_TABLE_SET = new Set<string>(PROJECTED_REF_TABLES);

/** True when a stored row's attributes say the projector wrote it. */
export function isProjectedRow(attributes: unknown): boolean {
  if (!attributes || typeof attributes !== 'object') return false;
  const prov = (attributes as { provenance?: unknown }).provenance;
  if (!prov || typeof prov !== 'object') return false;
  return (prov as { source?: unknown }).source === 'projection';
}

/**
 * Ids of stored graph nodes whose source row has disappeared. Only rows this
 * projector owns AND stamped as projected are eligible, so a hand-made node
 * survives a prune even when it names one of the same tables. Edges cascade
 * with the node (0129 FKs), so removing the id is enough.
 */
export function stalePrunableEntityIds(
  rows: Array<{ id: string; ref_table?: string | null; ref_id?: string | null; attributes?: unknown }>,
  projection: TwinProjection,
): string[] {
  const live = new Set(projection.entities.map((e) => e.key));
  const stale: string[] = [];
  for (const row of rows) {
    if (!row.ref_table || !row.ref_id) continue;          // manual/seeded node
    if (!PROJECTED_REF_TABLE_SET.has(row.ref_table)) continue; // somebody else's table
    if (!isProjectedRow(row.attributes)) continue;         // hand-made, keep it
    if (!live.has(`${row.ref_table}:${row.ref_id}`)) stale.push(row.id);
  }
  return stale;
}

const key = (table: string, id: string) => `${table}:${id}`;
const clean = (s: string | null | undefined, fallback: string) => {
  const t = (s ?? '').trim();
  return t.length ? t : fallback;
};

/**
 * The still-open actions on a paperwork item (`paperwork_items.actions` jsonb,
 * shaped by lib/paperwork/triage). An action a person already materialised into
 * a todo/bill carries `materialized_as`, so it is no longer outstanding and is
 * left out. Defensive about the jsonb: it is user-shaped data, not a type.
 */
export function openActionLabels(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  const labels: string[] = [];
  for (const raw of actions) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as { label?: unknown; kind?: unknown; materialized_as?: unknown };
    if (a.materialized_as) continue;
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    const kind = typeof a.kind === 'string' ? a.kind.trim() : '';
    const text = label || kind;
    if (text) labels.push(text);
  }
  return labels;
}

/**
 * Project a live household snapshot into a linked graph. People are the hubs;
 * their schools/teams/routines/pets/vehicles hang off them, and family-level
 * assets (places, accounts) become nodes too. Only edges with a resolvable
 * member endpoint are emitted (no dangling links).
 *
 * `opts.now` fixes `provenance.observed_at` so a run is deterministic (and so a
 * test can assert the stamp rather than a moving clock).
 */
export function projectTwin(snap: TwinSnapshot, opts: { now?: Date } = {}): TwinProjection {
  const observedAt = (opts.now ?? new Date()).toISOString();
  const entities = new Map<string, ProjectedEntity>();
  const edges: ProjectedEdge[] = [];
  const add = (e: ProjectedEntity) => {
    // Provenance is not optional: every projected node says where it came from
    // and when it was observed, because graph_entities has no columns for it.
    entities.set(e.key, {
      ...e,
      attributes: {
        ...(e.attributes ?? {}),
        provenance: { source: 'projection', observed_at: observedAt, ref_table: e.refTable },
      },
    });
  };
  const memberKeys = new Set(snap.members.map((m) => key('family_members', m.id)));
  const link = (sourceKey: string, targetKey: string | null, relation: string, weight: number) => {
    if (targetKey) edges.push({ sourceKey, targetKey, relation, weight });
  };
  const memberKey = (id: string | null | undefined) => {
    const k = id ? key('family_members', id) : null;
    return k && memberKeys.has(k) ? k : null;
  };

  for (const m of snap.members) {
    add({ key: key('family_members', m.id), kind: 'person', name: clean(m.name, 'Member'), refTable: 'family_members', refId: m.id });
  }
  for (const p of snap.pets) {
    add({ key: key('pets', p.id), kind: 'pet', name: clean(p.name, clean(p.species, 'Pet')), refTable: 'pets', refId: p.id });
    // pets are family-level; no reliable owner column, so no member edge.
  }
  for (const v of snap.vehicles) {
    const k = key('vehicles', v.id);
    add({ key: k, kind: 'item', name: clean(v.label, 'Vehicle'), refTable: 'vehicles', refId: v.id, attributes: { subkind: 'asset' } });
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

  // ── Events: what is coming, and who it lands on ────────────────────────────
  // The server loader supplies only the next EVENT_HORIZON_DAYS days; beyond
  // that a node is noise the reasoner would have to filter out anyway.
  for (const ev of snap.events ?? []) {
    const k = key('calendar_events', ev.id);
    add({
      key: k, kind: 'event', name: clean(ev.title, 'Event'), refTable: 'calendar_events', refId: ev.id,
      attributes: {
        subkind: 'event',
        starts_at: ev.starts_at ?? null,
        ends_at: ev.ends_at ?? null,
        all_day: ev.all_day ?? false,
        category: ev.category ?? null,
        location: ev.location ?? null,
      },
    });
    // calendar_events carries one attendee (`assignee_id`); there is no
    // attendees table, so that is the whole truth we can state.
    link(k, memberKey(ev.assignee_id), 'attended_by', 0.7);
  }

  // ── Places assets can sit in ───────────────────────────────────────────────
  for (const h of snap.homes ?? []) {
    add({ key: key('homes', h.id), kind: 'place', name: clean(h.name, 'Home'), refTable: 'homes', refId: h.id, attributes: { subkind: 'home' } });
  }
  for (const loc of snap.storageLocations ?? []) {
    add({
      key: key('home_locations', loc.id), kind: 'place', name: clean(loc.name, 'Location'),
      refTable: 'home_locations', refId: loc.id, attributes: { subkind: 'storage', location_kind: loc.kind ?? null },
    });
  }

  // ── Assets: what the household owns ────────────────────────────────────────
  for (const a of snap.homeAssets ?? []) {
    const k = key('home_assets', a.id);
    add({
      key: k, kind: 'item', name: clean(a.name, 'Asset'), refTable: 'home_assets', refId: a.id,
      attributes: { subkind: 'asset', asset_kind: 'home_asset', category: a.category ?? null, location: a.location ?? null, warranty_until: a.warranty_until ?? null },
    });
    link(k, a.home_id ? key('homes', a.home_id) : null, 'located_at', 0.5);
  }
  for (const it of snap.inventory ?? []) {
    const k = key('inventory_items', it.id);
    add({
      key: k, kind: 'item', name: clean(it.name, 'Item'), refTable: 'inventory_items', refId: it.id,
      attributes: { subkind: 'asset', asset_kind: 'inventory_item', category: it.category ?? null, status: it.status ?? null, value_cents: it.value_cents ?? null },
    });
    link(k, it.location_id ? key('home_locations', it.location_id) : null, 'located_at', 0.4);
    link(k, memberKey(it.owner_member_id), 'owned_by', 0.5);
  }
  for (const w of snap.warranties ?? []) {
    const k = key('home_warranties', w.id);
    add({
      key: k, kind: 'item', name: clean(w.name, 'Warranty'), refTable: 'home_warranties', refId: w.id,
      attributes: { subkind: 'warranty', provider: w.provider ?? null, expires_on: w.expires_on ?? null, status: w.status ?? null },
    });
    // A warranty covers the asset it names, or — when it is a whole-home plan —
    // the home. Never both, so the graph does not overstate coverage.
    if (w.asset_id) link(k, key('home_assets', w.asset_id), 'covers', 0.8);
    else if (w.home_id) link(k, key('homes', w.home_id), 'covers', 0.5);
  }
  for (const p of snap.projects ?? []) {
    const k = key('home_projects', p.id);
    add({
      key: k, kind: 'item', name: clean(p.title, 'Project'), refTable: 'home_projects', refId: p.id,
      attributes: { subkind: 'project', status: p.status ?? null, room: p.room ?? null, priority: p.priority ?? null },
    });
    // TODO(migration M3): home_projects has no asset_id, so a project→asset edge
    // cannot be stated truthfully yet. The owner edge is what the schema supports.
    link(k, memberKey(p.owner_id), 'owned_by', 0.5);
  }

  // ── Obligations: what the household owes, and by when ──────────────────────
  for (const b of snap.bills ?? []) {
    add({
      key: key('bills', b.id), kind: 'other', name: clean(b.name, 'Bill'), refTable: 'bills', refId: b.id,
      attributes: {
        subkind: 'obligation', obligation_kind: 'bill',
        due_on: b.due_date ?? null, amount: b.amount ?? null, status: b.status ?? null, category: b.category ?? null,
      },
    });
    // bills has no member column, so there is no owner edge to state.
  }
  for (const pw of snap.paperwork ?? []) {
    add({
      key: key('paperwork_items', pw.id), kind: 'other', name: clean(pw.title, 'Paperwork'), refTable: 'paperwork_items', refId: pw.id,
      attributes: {
        subkind: 'obligation', obligation_kind: 'paperwork',
        due_on: pw.due_on ?? null, amount: pw.amount ?? null, status: pw.status ?? null,
        paperwork_kind: pw.kind ?? null, open_actions: openActionLabels(pw.actions),
      },
    });
  }
  for (const r of snap.renewals ?? []) {
    const k = key('renewals', r.id);
    add({
      key: k, kind: 'other', name: clean(r.title, 'Renewal'), refTable: 'renewals', refId: r.id,
      attributes: {
        subkind: 'obligation', obligation_kind: 'renewal',
        due_on: r.expires_at ?? null, amount: r.cost ?? null, status: r.status ?? null, category: r.category ?? null,
      },
    });
    link(k, memberKey(r.member_id), 'owed_by', 0.6);
  }

  // ── Preferences: what the household likes, and how sure we are ─────────────
  // family_facts is the one table that already records source + confidence
  // (0265); both ride into attributes so a reader can weigh the claim.
  for (const pref of snap.preferences ?? []) {
    const k = key('family_facts', pref.id);
    add({
      key: k, kind: 'topic', name: clean(pref.label, 'Preference'), refTable: 'family_facts', refId: pref.id,
      attributes: {
        subkind: 'preference', value: pref.value ?? null,
        source: pref.source ?? null, confidence: pref.confidence ?? null,
      },
    });
    link(k, memberKey(pref.member_id), 'preference_of', 0.5);
  }

  // Drop any edge whose endpoints aren't both present (defensive).
  const safeEdges = edges.filter((e) => entities.has(e.sourceKey) && entities.has(e.targetKey));
  return { entities: [...entities.values()], edges: safeEdges };
}

// ── One graph, not two ───────────────────────────────────────────────────────
// The legacy `family_knowledge_nodes`/`_edges` tables (0022) were a second,
// hand-written graph nothing renders any more. These helpers let the family
// write path land manual nodes in the canonical `graph_entities`/`graph_edges`
// instead, so there is exactly one graph the reasoner reads.

/** Where a hand-made node came from — the counterpart to `ProjectionProvenance`. */
export type ManualProvenance = { source: 'manual'; observed_at: string };

const KNOWLEDGE_NODE_KINDS: Record<string, EntityKind> = {
  person: 'person', member: 'person', people: 'person', child: 'person', adult: 'person',
  activity: 'activity', sport: 'activity', hobby: 'activity', class: 'activity',
  place: 'place', location: 'place', home: 'place', venue: 'place',
  org: 'org', organization: 'org', school: 'org', provider: 'org', company: 'org',
  event: 'event', appointment: 'event', routine: 'event',
  item: 'item', asset: 'item', vehicle: 'item', account: 'item', thing: 'item',
  pet: 'pet', animal: 'pet',
  topic: 'topic', preference: 'topic', interest: 'topic', note: 'topic',
};

/**
 * Map the legacy free-text `node_type` onto the canonical `graph_entities.kind`
 * CHECK (0129). Anything unrecognised becomes `other` rather than being dropped
 * or guessed — the row still lands, honestly typed.
 */
export function knowledgeNodeKind(nodeType: string | null | undefined): EntityKind {
  const t = (nodeType ?? '').trim().toLowerCase();
  return KNOWLEDGE_NODE_KINDS[t] ?? 'other';
}

/**
 * `graph_edges.weight` is CHECKed to 0..1 while the legacy table allowed any
 * numeric(6,2). Clamp rather than reject, so a redirected write cannot fail on
 * a value the old table happily stored.
 */
export function clampEdgeWeight(weight: unknown): number {
  const n = typeof weight === 'number' ? weight : Number(weight);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export type KnowledgeWriteTarget = 'graph_entities' | 'graph_edges';

const KNOWLEDGE_WRITE_REDIRECT: Record<string, KnowledgeWriteTarget> = {
  family_knowledge_nodes: 'graph_entities',
  family_knowledge_edges: 'graph_edges',
};

/** The canonical graph table a legacy knowledge-graph write belongs in, if any. */
export function knowledgeGraphTarget(table: string): KnowledgeWriteTarget | null {
  return KNOWLEDGE_WRITE_REDIRECT[table] ?? null;
}

/**
 * Translate a whitelisted legacy knowledge-graph write into a canonical
 * `graph_entities` / `graph_edges` row. Only the keys the caller actually
 * supplied come out, so the same mapping serves an insert and a partial update
 * without nulling columns nobody touched. Columns the canonical tables do not
 * have (`member_id`, the legacy free-text `node_type`, the unbounded legacy
 * `weight`) are preserved in `attributes` rather than dropped, and the row is
 * stamped `provenance.source = 'manual'` so a reader can tell a typed-in node
 * from a projected one.
 */
export function toCanonicalGraphRow(
  target: KnowledgeWriteTarget,
  picked: Record<string, unknown>,
  observedAt: string,
): Record<string, unknown> {
  const provenance: ManualProvenance = { source: 'manual', observed_at: observedAt };
  if (target === 'graph_edges') {
    const row: Record<string, unknown> = { attributes: { provenance } };
    if (picked.source_id !== undefined) row.source_id = picked.source_id;
    if (picked.target_id !== undefined) row.target_id = picked.target_id;
    if (picked.relation !== undefined) row.relation = picked.relation;
    if (picked.weight !== undefined) row.weight = clampEdgeWeight(picked.weight);
    return row;
  }
  const row: Record<string, unknown> = {};
  const attributes: Record<string, unknown> = { provenance };
  if (picked.node_type !== undefined) {
    row.kind = knowledgeNodeKind(String(picked.node_type));
    attributes.node_type = picked.node_type;
  }
  if (picked.label !== undefined) row.name = String(picked.label);
  if (picked.ref_table !== undefined) row.ref_table = picked.ref_table;
  if (picked.ref_id !== undefined) row.ref_id = picked.ref_id;
  if (picked.member_id !== undefined) attributes.member_id = picked.member_id;
  if (picked.weight !== undefined) attributes.weight = clampEdgeWeight(picked.weight);
  row.attributes = attributes;
  return row;
}

/** Small summary for the UI ("linked N people, M activities…"). */
export function projectionSummary(p: TwinProjection): { entities: number; edges: number; byKind: Record<string, number> } {
  const byKind: Record<string, number> = {};
  for (const e of p.entities) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return { entities: p.entities.length, edges: p.edges.length, byKind };
}
