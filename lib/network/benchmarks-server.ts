// Service-role reads for the benchmark report, export and public page.
//
// Both tables are read with the service client on purpose: `network_aggregates`
// is RLS-gated to consenting families (right for the in-app surface, wrong for
// a public research page), and `marketing_settings` is admin-only. What comes
// out is already k-anonymized and DP-noised, and every caller re-applies the
// floor through benchmarks.ts. A failed read is a failed read — callers get
// `{ ok: false }` and must render an error, never an empty benchmark.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { BENCHMARKS_PUBLICATION_KEY, isBenchmarksPublished } from './benchmarks';
import { K_ANONYMITY_FLOOR, type ConsentScope } from './insights';
import type { NetworkAggregate } from './aggregate';

type DB = SupabaseClient<Database>;

export type PublicationRead = { ok: true; published: boolean; updatedAt: string | null } | { ok: false };

export async function readBenchmarksPublication(sb: DB): Promise<PublicationRead> {
  const { data, error } = await sb.from('marketing_settings')
    .select('value, updated_at').eq('key', BENCHMARKS_PUBLICATION_KEY).maybeSingle();
  if (error) {
    console.error('[benchmarks] publication flag read failed', error);
    return { ok: false };
  }
  return { ok: true, published: isBenchmarksPublished(data?.value), updatedAt: data?.updated_at ?? null };
}

export type AggregatesRead = { ok: true; aggregates: NetworkAggregate[]; computedAt: string | null } | { ok: false };

/** Every published benchmark row at or above the floor, newest computation first. */
export async function readBenchmarkAggregates(sb: DB): Promise<AggregatesRead> {
  const { data, error } = await sb.from('network_aggregates')
    .select('scope, cohort_key, metric, value, count, cohort_size, computed_at')
    .eq('scope', 'benchmarks')
    .gte('cohort_size', K_ANONYMITY_FLOOR)
    .order('cohort_size', { ascending: false })
    .limit(2000);
  if (error) {
    console.error('[benchmarks] aggregate read failed', error);
    return { ok: false };
  }
  const rows = data ?? [];
  const computedAt = rows.reduce<string | null>((latest, r) => (!latest || r.computed_at > latest ? r.computed_at : latest), null);
  return {
    ok: true,
    computedAt,
    aggregates: rows.map((a) => ({
      scope: a.scope as ConsentScope, cohortKey: a.cohort_key, metric: a.metric,
      value: a.value, count: a.count, cohortSize: a.cohort_size,
    })),
  };
}
