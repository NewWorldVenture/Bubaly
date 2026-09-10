import 'server-only';
import { unstable_cache } from 'next/cache';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export type PublicStats = {
  families: number;
  members: number;
  tasksCompleted: number;
  /** Legacy RPC field: runs marked completed OR partially_completed. */
  handledCompleted: number;
  /** Matching runs with completed_at at or after the 30-day cutoff; no upper date bound. */
  handled30d: number;
  /** Distinct families with at least one matching complete or partial run. */
  familiesWithRuns: number;
};

export const EMPTY_PUBLIC_STATS: PublicStats = {
  families: 0, members: 0, tasksCompleted: 0,
  handledCompleted: 0, handled30d: 0, familiesWithRuns: 0,
};

// Anonymous client (not cookie-bound) so this works during static generation
// and on public marketing pages. Reads only the public_stats() and
// public_handled_stats() RPCs, which return non-identifying aggregate counts.
function anonClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}

type Row = Record<string, unknown>;

function firstRow(data: unknown): Row {
  if (Array.isArray(data) && data.length !== 1) throw new Error('Expected one aggregate row');
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid aggregate row');
  return row as Row;
}

function num(row: Row, key: string): number {
  const value = row[key];
  // PostgREST can return bigint counts as decimal strings. Never coerce null,
  // booleans, blank strings or rounded unsafe integers into public evidence.
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid aggregate count: ${key}`);
  return parsed;
}

/**
 * Migration 0278 defines `public_handled_stats()`; the generated Database type
 * does not carry it yet. The legacy names include partial runs. The call is typed loosely and
 * every failure — including PostgREST's "function does not exist" — degrades
 * to zeros, which the formatters then HIDE (lib/marketing/format.ts
 * HANDLED_PUBLIC_MIN). The marketing site never reads family_automation_runs
 * directly: the RPC is the only door, and it is SECURITY DEFINER + aggregate.
 */
type HandledStatsRpc = {
  rpc: (fn: 'public_handled_stats') => PromiseLike<{ data: unknown; error: unknown }>;
};

type HandledStats = Pick<PublicStats, 'handledCompleted' | 'handled30d' | 'familiesWithRuns'>;
type AccountStats = Pick<PublicStats, 'families' | 'members' | 'tasksCompleted'>;

async function readHandledStats(client: SupabaseClient<Database>): Promise<HandledStats> {
  try {
    const { data, error } = await (client as unknown as HandledStatsRpc).rpc('public_handled_stats');
    if (error) throw error;
    const row = firstRow(data);
    const counts = {
      handledCompleted: num(row, 'runs_completed'),
      handled30d: num(row, 'runs_completed_30d'),
      familiesWithRuns: num(row, 'families_with_runs'),
    };
    if (counts.handled30d > counts.handledCompleted || counts.familiesWithRuns > counts.handledCompleted) {
      throw new Error('Inconsistent aggregate counts');
    }
    return counts;
  } catch (err) {
    // Zeros are what the formatters HIDE, so a failed read shows nothing
    // rather than a number — but it is still logged, because "the RPC is not
    // applied yet" and "Supabase is down" look identical from the page.
    console.error('[marketing-stats] public_handled_stats read failed (rendering no handled aggregates)', err);
    return { handledCompleted: 0, handled30d: 0, familiesWithRuns: 0 };
  }
}

async function readAccountStats(client: SupabaseClient<Database>): Promise<AccountStats> {
  try {
    const { data, error } = await client.rpc('public_stats');
    if (error) throw error;
    const row = firstRow(data);
    return {
      families: num(row, 'families'),
      members: num(row, 'members'),
      tasksCompleted: num(row, 'tasks_completed'),
    };
  } catch (err) {
    console.error('[marketing-stats] public_stats read failed (rendering no family counts)', err);
    return { families: 0, members: 0, tasksCompleted: 0 };
  }
}

/** Real aggregate counts for the public site, cached for an hour. Degrades to
 *  zeros if Supabase is unreachable so marketing pages always render — and the
 *  two RPCs fail independently, so a missing handled-stats function never
 *  hides the registered-family count. */
export const getPublicStats = unstable_cache(
  async (): Promise<PublicStats> => {
    let client: SupabaseClient<Database>;
    try {
      client = anonClient();
    } catch (err) {
      console.error('[marketing-stats] public client unavailable (rendering no aggregates)', err);
      return { ...EMPTY_PUBLIC_STATS };
    }
    const [accounts, handled] = await Promise.all([readAccountStats(client), readHandledStats(client)]);
    return { ...accounts, ...handled };
  },
  ['public-stats-validated-v2'],
  { revalidate: 3600 },
);
