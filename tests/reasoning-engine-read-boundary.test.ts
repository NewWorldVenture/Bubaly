import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadReasoningReport } from '@/lib/reasoning/engine-server';

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

// The FOI/graph sources are each wrapped in `.catch(() => null)` by the loader,
// so making every non-signals table throw lets them degrade to "no contribution"
// (calm) while we isolate the family_signals read boundary.
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

  it('logs the read failure and still produces an all-clear report when signals error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase({ data: null, error: { message: 'permission denied for table family_signals' } });

    const report = await loadReasoningReport(supabase, 'fam-1', new Date('2026-07-16T12:00:00Z'));

    // Degrades to calm (no signals contributed) rather than throwing.
    expect(report.answers).toHaveLength(6);

    // A broken family_signals table must leave a diagnosable signal.
    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('[reasoning-engine] family_signals read failed');
  });

  it('does not log a family_signals failure when the read succeeds', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase({ data: [], error: null });

    await loadReasoningReport(supabase, 'fam-1', new Date('2026-07-16T12:00:00Z'));

    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged).not.toContain('[reasoning-engine] family_signals read failed');
  });
});
