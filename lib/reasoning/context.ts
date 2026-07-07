// lib/reasoning/context.ts — the single graph-backed "family context" the whole
// AI Operating Layer reasons over. This is moat R1: making the Knowledge Graph
// the BRAIN rather than a standalone page. Every AI surface (FOI · Concierge ·
// Briefing · Playbook · Calm · Decisions · Prep-Plans · Outcomes · the Chief of
// Staff) should load THIS instead of issuing ad-hoc per-table reads, so they
// reason across relationships (Emma → Soccer → Field → Weather → Dinner) rather
// than retrieving isolated rows.
//
// Pure + fully unit-tested; the server loader (lib/reasoning/server.ts) feeds it
// real graph_entities / graph_edges rows. Thin, domain-friendly wrappers over the
// traversal core in lib/graph/reason.ts — no new graph logic, just one front door.

import {
  buildIndex, neighbours, reachable, propagateImpact, findPath, describePath, hubs,
  type Graph, type GraphEntity, type GraphEdge, type GraphIndex, type EntityKind,
  type Neighbour, type Impact,
} from '@/lib/graph/reason';

/** Raw graph_entities row (snake_case) as Supabase returns it. */
export interface EntityRow {
  id: string; kind: string; name: string;
  ref_table: string | null; ref_id: string | null; attributes: unknown;
}
/** Raw graph_edges row (snake_case) as Supabase returns it. */
export interface EdgeRow {
  id: string; source_id: string; target_id: string;
  relation: string; weight: number | string | null; attributes: unknown;
}

const KINDS: EntityKind[] = ['person', 'activity', 'place', 'org', 'event', 'item', 'pet', 'topic', 'other'];
const asKind = (k: string): EntityKind => (KINDS.includes(k as EntityKind) ? (k as EntityKind) : 'other');
const asAttrs = (a: unknown): Record<string, unknown> =>
  a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {};

export function entityFromRow(r: EntityRow): GraphEntity {
  return { id: r.id, kind: asKind(r.kind), name: r.name, refTable: r.ref_table, refId: r.ref_id, attributes: asAttrs(r.attributes) };
}
export function edgeFromRow(r: EdgeRow): GraphEdge {
  const w = typeof r.weight === 'string' ? parseFloat(r.weight) : (r.weight ?? 1);
  return {
    id: r.id, sourceId: r.source_id, targetId: r.target_id, relation: r.relation,
    weight: Number.isFinite(w as number) ? (w as number) : 1, attributes: asAttrs(r.attributes),
  };
}
/** Build a pure Graph from raw Supabase rows. */
export function graphFromRows(entities: EntityRow[], edges: EdgeRow[]): Graph {
  return { entities: entities.map(entityFromRow), edges: edges.map(edgeFromRow) };
}

/** A relationship path with a human description, e.g. "Emma → plays → Soccer". */
export interface Connection { path: GraphEntity[]; description: string }

/**
 * The family's linked model, ready to reason over. Methods wrap the graph
 * traversal core with the domain's vocabulary so callers ask household questions
 * ("what does this event depend on?", "who is connected to the dentist?") instead
 * of walking edges by hand.
 */
export interface FamilyContext {
  familyId: string;
  graph: Graph;
  index: GraphIndex;
  /** No graph yet (new family, or the projector hasn't run). Callers degrade gracefully. */
  isEmpty: boolean;

  /** Entity by graph id. */
  entity(id: string): GraphEntity | undefined;
  /** All entities of a kind (person/activity/place/org/event/item/pet/topic/other). */
  byKind(kind: EntityKind): GraphEntity[];
  /** The graph node mirroring a specific source row (e.g. a family_members id). */
  byRef(refTable: string, refId: string): GraphEntity | undefined;
  /** The people mirrored from family_members (the household roster in the graph). */
  members(): GraphEntity[];

  /** Direct relations of a node, both directions, deduped. */
  related(id: string): Neighbour[];
  /** Neighbouring entities reached by a specific relation (e.g. 'plays', 'coached_by'). */
  relatedByRelation(id: string, relation: string): GraphEntity[];
  /** Everything within `maxDepth` hops (the local neighbourhood). */
  neighbourhood(id: string, maxDepth?: number): Array<{ entity: GraphEntity; depth: number }>;
  /** Impact blast-radius: what a change to this node ripples out to, ranked. */
  ripple(id: string, maxDepth?: number): Impact[];
  /** The shortest relationship path between two nodes, with a description. */
  connection(fromId: string, toId: string): Connection | null;
  /** The household's most-connected entities ("hubs" the AI should watch). */
  keyHubs(limit?: number): Array<{ entity: GraphEntity; degree: number }>;
}

export function buildFamilyContext(familyId: string, graph: Graph): FamilyContext {
  const index = buildIndex(graph);
  const byRefKey = new Map<string, GraphEntity>();
  for (const e of graph.entities) {
    if (e.refTable && e.refId) byRefKey.set(`${e.refTable}:${e.refId}`, e);
  }
  return {
    familyId,
    graph,
    index,
    isEmpty: graph.entities.length === 0,
    entity: (id) => index.byId.get(id),
    byKind: (kind) => graph.entities.filter((e) => e.kind === kind),
    byRef: (t, i) => byRefKey.get(`${t}:${i}`),
    members: () => graph.entities.filter((e) => e.kind === 'person' && e.refTable === 'family_members'),
    related: (id) => neighbours(index, id),
    relatedByRelation: (id, relation) =>
      neighbours(index, id).filter((n) => n.relation === relation).map((n) => n.entity),
    neighbourhood: (id, maxDepth = 2) => reachable(index, id, maxDepth),
    ripple: (id, maxDepth = 4) => propagateImpact(index, id, { maxDepth }),
    connection: (fromId, toId) => {
      const path = findPath(index, fromId, toId);
      return path ? { path, description: describePath(index, path) } : null;
    },
    keyHubs: (limit = 5) => hubs(index, limit),
  };
}

/** An empty context (no graph) — the safe fallback while a family has no graph yet. */
export function emptyFamilyContext(familyId = ''): FamilyContext {
  return buildFamilyContext(familyId, { entities: [], edges: [] });
}
