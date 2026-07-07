// lib/reasoning/server.ts — the one place the AI Operating Layer loads a family's
// linked model from Supabase. Reads graph_entities + graph_edges (family-scoped
// RLS) and hands back a FamilyContext (moat R1). AI surfaces call
// `loadFamilyContext(sb, familyId)` and reason over relationships instead of
// issuing their own per-table reads.

import type { SupabaseClient } from '@supabase/supabase-js';
import { graphFromRows, buildFamilyContext, emptyFamilyContext, type FamilyContext } from './context';
import type { Graph } from '@/lib/graph/reason';

// Accept any Supabase client (server or service-role); the caller owns auth/RLS.
type DB = Pick<SupabaseClient, 'from'>;

/** Load the raw graph (entities + edges) for a family. Empty on any read error. */
export async function loadFamilyGraph(sb: DB, familyId: string): Promise<Graph> {
  const [entRes, edgeRes] = await Promise.all([
    sb.from('graph_entities').select('id, kind, name, ref_table, ref_id, attributes').eq('family_id', familyId),
    sb.from('graph_edges').select('id, source_id, target_id, relation, weight, attributes').eq('family_id', familyId),
  ]);
  if (entRes.error || edgeRes.error) {
    console.error('[reasoning] graph load failed', entRes.error ?? edgeRes.error);
    return { entities: [], edges: [] };
  }
  return graphFromRows(entRes.data ?? [], edgeRes.data ?? []);
}

/**
 * The AI Operating Layer's entry point: the family's graph-backed context, ready
 * to reason over. Degrades to an empty context (never throws) so a family without
 * a projected graph yet still renders — callers check `ctx.isEmpty`.
 */
export async function loadFamilyContext(sb: DB, familyId: string): Promise<FamilyContext> {
  if (!familyId) return emptyFamilyContext(familyId);
  const graph = await loadFamilyGraph(sb, familyId);
  return buildFamilyContext(familyId, graph);
}
