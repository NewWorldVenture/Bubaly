// lib/reasoning/context.ts — R1: the one graph-backed context loader.
//
// The realignment thesis (todo.md) is that the Knowledge Graph must become the
// *substrate every capability reasons over*, not a standalone page. Today each
// AI surface (FOI, Concierge, Briefing, Playbook, Calm, Decisions, Prep-Plans,
// Agents…) loads its own isolated `.from()` rows. This module gives them ONE
// call — `loadFamilyContext(familyId)` — that returns the family's graph
// (entities + edges) joined with the live household snapshot + operating index,
// pre-indexed with the reasoning primitives surfaces need (hubs, impact, a
// row→node join). The pure core (`assembleFamilyContext` + helpers) is DB-free
// and unit-tested; the server loader just fetches rows and hands them in.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  buildIndex, hubs, orphans, reachable, propagateImpact,
  type Graph, type GraphEntity, type GraphEdge, type GraphIndex, type EntityKind, type Impact,
  EMPTY_GRAPH,
} from '@/lib/graph/reason';
import {
  computeOperatingIndex,
  type HouseholdSnapshot, type OperatingIndex,
} from '@/lib/operating-index/score';

type DB = SupabaseClient<Database>;

/** The unified family reasoning context every AI surface can call for. */
export interface FamilyContext {
  familyId: string;
  /** Raw knowledge graph (entities + directed, weighted edges). */
  graph: Graph;
  /** Pre-built adjacency index for O(1) lookup + traversal. */
  graphIndex: GraphIndex;
  /** Live normalized household snapshot (planning, finances, routines…). */
  snapshot: HouseholdSnapshot;
  /** Operating Index (composite 0–100, band, dimensions) derived from the snapshot. */
  operatingIndex: OperatingIndex;
  /** Coordination hubs — the most-connected nodes, highest first. */
  hubs: Array<{ entity: GraphEntity; degree: number }>;
  /** How many entities have no edges (coverage gaps the AI can't reason over yet). */
  orphanCount: number;
  /** "table:id" → graph entity, so a surface can join a DB row to its node. */
  refIndex: Map<string, GraphEntity>;
  /** Cheap observability: counts for logging / empty-state decisions. */
  stats: { entities: number; edges: number; byKind: Record<string, number> };
}

/** Stable key for the row→node join (`family_members:<uuid>` etc.). */
export function refKey(table: string | null | undefined, id: string | null | undefined): string {
  return `${table ?? ''}:${id ?? ''}`;
}

/** Map a raw `graph_entities` row to the pure engine's `GraphEntity`. */
export function mapEntityRow(row: {
  id: string; kind: string | null; name: string;
  ref_table?: string | null; ref_id?: string | null; attributes?: unknown;
}): GraphEntity {
  return {
    id: row.id,
    kind: (row.kind ?? 'other') as EntityKind,
    name: row.name,
    refTable: row.ref_table ?? null,
    refId: row.ref_id ?? null,
    attributes: (row.attributes as Record<string, unknown>) ?? undefined,
  };
}

/** Map a raw `graph_edges` row to the pure engine's `GraphEdge`. */
export function mapEdgeRow(row: {
  id: string; source_id: string; target_id: string; relation: string;
  weight?: number | null; attributes?: unknown;
}): GraphEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation,
    weight: typeof row.weight === 'number' ? row.weight : 1,
    attributes: (row.attributes as Record<string, unknown>) ?? undefined,
  };
}

/**
 * Pure assembly of a `FamilyContext` from a graph + snapshot. DB-free and
 * deterministic (given `now`), so every reasoning primitive here is unit-tested
 * without a database.
 */
export function assembleFamilyContext(input: {
  familyId: string;
  graph: Graph;
  snapshot: HouseholdSnapshot;
  now?: Date;
}): FamilyContext {
  const { familyId, graph, snapshot, now = new Date() } = input;
  const graphIndex = buildIndex(graph);
  const operatingIndex = computeOperatingIndex(snapshot, now);

  const refIndex = new Map<string, GraphEntity>();
  const byKind: Record<string, number> = {};
  for (const e of graph.entities) {
    if (e.refTable && e.refId) refIndex.set(refKey(e.refTable, e.refId), e);
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }

  return {
    familyId,
    graph,
    graphIndex,
    snapshot,
    operatingIndex,
    hubs: hubs(graphIndex, 5),
    orphanCount: orphans(graphIndex).length,
    refIndex,
    stats: { entities: graph.entities.length, edges: graph.edges.length, byKind },
  };
}

/** The graph node mirroring a specific DB row (e.g. a `family_members` row), if any. */
export function entityForRow(ctx: FamilyContext, table: string, id: string): GraphEntity | null {
  return ctx.refIndex.get(refKey(table, id)) ?? null;
}

/** Everything reachable from an entity within `maxDepth` hops — the "what does this touch" set. */
export function relatedTo(ctx: FamilyContext, entityId: string, maxDepth = 2): Array<{ entity: GraphEntity; depth: number }> {
  return reachable(ctx.graphIndex, entityId, maxDepth);
}

/** Impact blast-radius from an entity (weather→field→game→dinner), highest score first. */
export function impactFrom(ctx: FamilyContext, entityId: string): Impact[] {
  return propagateImpact(ctx.graphIndex, entityId);
}

/** One-line narrative of the context — usable in a prompt preamble or a UI strip. */
export function contextSummary(ctx: FamilyContext): string {
  const { entities, edges } = ctx.stats;
  if (entities === 0) return 'No knowledge graph yet — reasoning from live data only.';
  const top = ctx.hubs[0];
  const hubNote = top && top.degree >= 2 ? ` · hub: ${top.entity.name}` : '';
  return `Reasoning over ${entities} ${entities === 1 ? 'entity' : 'entities'} and ${edges} ${edges === 1 ? 'link' : 'links'} · household ${ctx.operatingIndex.composite}/100 (${ctx.operatingIndex.band})${hubNote}`;
}

// ─── Server loaders ──────────────────────────────────────────────────────────

/**
 * Load a family's knowledge graph from Supabase into the pure `Graph` shape.
 * Resilient by design: a missing table / rejected read degrades to an empty
 * graph rather than throwing (so a surface never crashes on a drifted DB).
 */
export async function loadFamilyGraph(supabase: DB, familyId: string): Promise<Graph> {
  const [ents, edges] = await Promise.all([
    supabase.from('graph_entities')
      .select('id, kind, name, ref_table, ref_id, attributes')
      .eq('family_id', familyId).limit(4000),
    supabase.from('graph_edges')
      .select('id, source_id, target_id, relation, weight, attributes')
      .eq('family_id', familyId).limit(8000),
  ]);
  return {
    entities: (ents.data ?? []).map(mapEntityRow),
    edges: (edges.data ?? []).map(mapEdgeRow),
  };
}

/**
 * R1 — the single graph-backed context loader every AI surface calls. Fetches
 * the family's graph + builds the live household snapshot, then assembles them
 * (with the operating index + reasoning primitives) via the pure core.
 *
 * `buildSnapshot` is imported dynamically so this module's *static* import graph
 * stays free of `server-only` code — that keeps the pure core (and its tests)
 * importable in a plain Node/vitest environment.
 */
export async function loadFamilyContext(supabase: DB, familyId: string, now: Date = new Date()): Promise<FamilyContext> {
  const [graph, { buildSnapshot }] = await Promise.all([
    loadFamilyGraph(supabase, familyId),
    import('@/lib/operating-index/server'),
  ]);
  const snapshot = await buildSnapshot(supabase, familyId, now);
  return assembleFamilyContext({ familyId, graph, snapshot, now });
}

export { EMPTY_GRAPH };
