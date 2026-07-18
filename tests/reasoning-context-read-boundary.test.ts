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

  it('fails closed (throws) on a read error so each route renders a truthful retryable state, and logs the failure', async () => {
    // Design (context.ts `loadFamilyGraph`): a rejected/missing-table read is a
    // data-integrity failure, NOT an empty graph. The loader throws rather than
    // presenting a partial relationship view as current; every caller catches it
    // (`.catch(() => null)` or try/catch → <ErrorState>/<ReadFailure>) and shows
    // a retryable state. This test pins that fail-closed contract + observability.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readError = { message: 'permission denied for table graph_entities' };
    const supabase = fakeSupabase({
      graph_entities: { data: null, error: readError },
      graph_edges: { data: null, error: { message: 'relation graph_edges does not exist' } },
    });

    // Fail-closed: the read error surfaces to the caller instead of being
    // swallowed into an empty graph.
    await expect(loadFamilyGraph(supabase, 'fam-1')).rejects.toEqual(readError);

    // Observability: the failure still leaves a diagnosable signal so a
    // drifted/broken graph table is not silently invisible.
    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('[reasoning] graph read failed');
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
