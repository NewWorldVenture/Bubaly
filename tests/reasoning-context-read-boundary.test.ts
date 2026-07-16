import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadFamilyGraph } from '@/lib/reasoning/context';

// A chainable query stub whose terminal `.limit()` resolves to the supplied
// PostgREST-shaped `{ data, error }`. Mirrors the exact call the loader makes:
// `from(table).select(cols).eq('family_id', id).limit(n)`.
function queryResult(result: { data: unknown; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    limit: () => Promise.resolve(result),
  };
  return chain;
}

function fakeSupabase(results: Record<string, { data: unknown; error: unknown }>): SupabaseClient<Database> {
  return {
    from: (table: string) => queryResult(results[table] ?? { data: [], error: null }),
  } as unknown as SupabaseClient<Database>;
}

describe('loadFamilyGraph read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('degrades to an empty graph (never throws) when both reads fail, and logs each failure', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase({
      graph_entities: { data: null, error: { message: 'permission denied for table graph_entities' } },
      graph_edges: { data: null, error: { message: 'relation graph_edges does not exist' } },
    });

    const graph = await loadFamilyGraph(supabase, 'fam-1');

    // Graceful degradation: an empty graph, not a thrown exception.
    expect(graph.entities).toEqual([]);
    expect(graph.edges).toEqual([]);

    // Observability: a swallowed read error must still leave a signal so a
    // drifted/broken graph table is diagnosable instead of silently invisible.
    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('[reasoning-context] graph_entities read failed');
    expect(logged).toContain('[reasoning-context] graph_edges read failed');
  });

  it('does not log when both reads succeed, and maps the rows', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase({
      graph_entities: { data: [{ id: 'e1', kind: 'person', name: 'Emma', ref_table: 'family_members', ref_id: 'm-1' }], error: null },
      graph_edges: { data: [{ id: 'edge1', source_id: 'e1', target_id: 'e2', relation: 'plays', weight: 1 }], error: null },
    });

    const graph = await loadFamilyGraph(supabase, 'fam-1');

    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0]).toMatchObject({ id: 'e1', kind: 'person', name: 'Emma' });
    expect(graph.edges).toHaveLength(1);
    expect(err).not.toHaveBeenCalled();
  });
});
