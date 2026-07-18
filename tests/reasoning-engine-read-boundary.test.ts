import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadAndSnapshotReasoning, loadReasoningReport } from '@/lib/reasoning/engine-server';

// A chainable query stub: select/eq/order/limit all return the chain, and the
// chain is awaitable, resolving to the supplied PostgREST-shaped result.
function signalsChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve(result),
  };
  return chain;
}

// Making every non-signals table throw isolates source-failure metadata while
// preserving the report shape and its six answers.
function fakeSupabase(signalsResult: { data: unknown; error: unknown }): SupabaseClient<Database> {
  return {
    from: (table: string) => {
      if (table === 'family_signals') return signalsChain(signalsResult);
      throw new Error(`unmocked table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

describe('loadReasoningReport family_signals read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the read failure and marks the report degraded when signals error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase({ data: null, error: { message: 'permission denied for table family_signals' } });

    const report = await loadReasoningReport(supabase, 'fam-1', new Date('2026-07-16T12:00:00Z'));

    expect(report.answers).toHaveLength(6);
    expect(report.allClear).toBe(false);
    expect(report.readErrors).toEqual(['operating_index', 'relationship_graph', 'family_signals']);

    // A broken family_signals table must leave a diagnosable signal.
    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('[reasoning-engine] family_signals read failed');
  });

  it('does not log a family_signals failure when the read succeeds', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase({ data: [], error: null });

    const report = await loadReasoningReport(supabase, 'fam-1', new Date('2026-07-16T12:00:00Z'));

    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged).not.toContain('[reasoning-engine] family_signals read failed');
    expect(report.readErrors).toEqual(['operating_index', 'relationship_graph']);
  });
});

// A chain whose terminal `.upsert()` resolves to the supplied result; other
// tables throw so the report sources degrade cleanly and isolate the write path.
function snapshotSupabase(upsertResult: { error: unknown }): SupabaseClient<Database> {
  return {
    from: (table: string) => {
      if (table === 'reasoning_snapshots') {
        return {
          upsert: () => Promise.resolve({ data: null, error: upsertResult.error }),
        };
      }
      if (table === 'family_signals') return signalsChain({ data: [], error: null });
      throw new Error(`unmocked table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

describe('loadAndSnapshotReasoning snapshot write boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the upsert failure and still returns the report', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = snapshotSupabase({ error: { message: 'relation reasoning_snapshots does not exist' } });

    const report = await loadAndSnapshotReasoning(supabase, 'fam-1', null, new Date('2026-07-16T12:00:00Z'));

    expect(report.answers).toHaveLength(6);
    expect(report.readErrors).toEqual(['operating_index', 'relationship_graph']);
    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('[reasoning-engine] reasoning_snapshots upsert failed');
  });

  it('does not log a snapshot failure when the upsert succeeds', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = snapshotSupabase({ error: null });

    await loadAndSnapshotReasoning(supabase, 'fam-1', null, new Date('2026-07-16T12:00:00Z'));

    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged).not.toContain('[reasoning-engine] reasoning_snapshots upsert failed');
  });
});
