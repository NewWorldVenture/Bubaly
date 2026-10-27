// Service-role reads for the benchmark report, export and public page.
//
// Both tables are read with the service client on purpose: `network_aggregates`
// is RLS-gated to consenting families (right for the in-app surface, wrong for
// a public research page), and `marketing_settings` is admin-only. What comes
// out is already k-anonymized and DP-noised, and every caller re-applies the
// floor through benchmarks.ts. A failed read is a failed read — callers get
// `{ ok: false }` and must render an error, never an empty benchmark.

// Server-only: reads network-wide benchmark aggregates through the service-role
// client. Protected transitively today (it imports lib/supabase/server, which
// imports next/headers), but that is inherited rather than declared — see the
// note in lib/supabase/server.ts.
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/database.types';
import { BENCHMARKS_PUBLICATION_KEY, isBenchmarksPublished } from './benchmarks';
import { K_ANONYMITY_FLOOR, type ConsentScope } from './insights';
import { freshAggregatesSince, type NetworkAggregate } from './aggregate';
import { readAllById } from '@/lib/supabase/read-all';
import { readAllInChunks } from '@/lib/supabase/chunked-in';

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

/**
 * Whether /resources/benchmarks currently EXISTS, for a caller that only wants
 * to know whether it may link there. The page 404s unless this flag is on, so a
 * surface that advertises it without asking is advertising a 404.
 *
 * False for every uncertainty — service role unconfigured, the read errored, the
 * request never completed. A link we cannot prove leads somewhere is not shown,
 * which is the honest direction: the worst case is a family not seeing a card
 * about a page that is published, not a family landing on a dead end.
 */
export async function benchmarksPageIsPublished(): Promise<boolean> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const read = await readBenchmarksPublication(createServiceClient());
    return read.ok && read.published;
  } catch (cause) {
    console.error('[benchmarks] publication flag read failed', cause);
    return false;
  }
}

export type AggregatesRead = { ok: true; aggregates: NetworkAggregate[]; computedAt: string | null } | { ok: false };

/**
 * Every published benchmark row at or above the floor, in no order a reader
 * relies on: benchmarks.ts orders them for display (benchmarkRows).
 *
 * Only FRESH rows count as published (`freshAggregatesSince`). The table keeps
 * whatever the last successful run wrote, and every run that fails before it
 * stands behind the figures again leaves them in place for as long as the
 * cron keeps failing. (A family that withdrew is inside fresh figures too,
 * until the next epoch's snapshot: freshness says the cron is alive, not who
 * is in the figures.) Past the age limit the page, the
 * export and the report fall to their empty state instead. `computedAt` is
 * still the newest row's, stale or not, so the report can say when the
 * aggregation last wrote anything. Inside a publication epoch every run that
 * completes re-stamps the snapshot it holds without changing a figure
 * (aggregate-server.ts), so `computedAt` is when a run last stood behind the
 * figures, not when they last changed.
 */
export async function readBenchmarkAggregates(sb: DB, now: Date = new Date()): Promise<AggregatesRead> {
  // `.limit(2000)` never was 2,000 — PostgREST caps at db-max-rows — so this
  // read pages, to a real ceiling of 2,000.
  //
  // It pages on the primary key, past the last id read, and not by offset
  // over (cohort_size desc, cohort_key, metric, value, id). That order was
  // made total (DATA-015: a tie split across a page boundary duplicated one
  // band and dropped another), but an offset page is still a separate read of
  // a table the aggregation rewrites while it is read: an epoch's publish
  // upserts every band in place, moving any whose cohort_size changed to
  // another position, and then deletes the earlier epoch's rows. A read whose
  // two pages fell either side of that read a band twice or not at all, and a
  // missing band is not a shorter benchmark, it is a different one. An id
  // does not move, so a band present for the whole read is read exactly once.
  const { rows: data, error } = await readAllById((cursor, limit) => {
    const page = sb.from('network_aggregates')
      .select('id, scope, cohort_key, metric, value, count, cohort_size, computed_at')
      .eq('scope', 'benchmarks')
      .gte('cohort_size', K_ANONYMITY_FLOOR)
      .order('id').limit(limit);
    return cursor ? page.gt('id', cursor) : page;
  }, { max: 2000 });
  if (error) {
    console.error('[benchmarks] aggregate read failed', error);
    return { ok: false };
  }
  const rows = data ?? [];
  const computedAt = rows.reduce<string | null>((latest, r) => (!latest || r.computed_at > latest ? r.computed_at : latest), null);
  const since = Date.parse(freshAggregatesSince(now));
  return {
    ok: true,
    computedAt,
    aggregates: rows.filter((a) => Date.parse(a.computed_at) >= since).map((a) => ({
      scope: a.scope as ConsentScope, cohortKey: a.cohort_key, metric: a.metric,
      value: a.value, count: a.count, cohortSize: a.cohort_size,
    })),
  };
}

export type TrueSizesRead = { ok: true; sizes: Map<string, number> } | { ok: false };

/**
 * The TRUE family count behind each of these aggregate rows, by id — for the
 * k-floor on the server and for nothing else.
 *
 * A family's own view reads its cohort's rows through RLS, and `cohort_size`
 * is not a column that read names: it is the un-noised figure beside the
 * noised `count`, and through RLS any member of any consenting family can
 * select it for every cohort and difference it night over night until the
 * column grant (an owner's migration) takes it away from `authenticated`. The
 * floor is re-checked here instead, with the service role, on exactly the
 * rows RLS already let the family see, and the number never leaves the server.
 *
 * `{ ok: false }` for every uncertainty — unconfigured, refused, unreachable —
 * and the caller then shows no insight rather than an unchecked one.
 */
export async function readTrueCohortSizes(ids: readonly string[]): Promise<TrueSizesRead> {
  if (ids.length === 0) return { ok: true, sizes: new Map() };
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[benchmarks] the k-floor re-check needs the service role, which is not configured');
    return { ok: false };
  }
  try {
    const sb = createServiceClient();
    const { data, error } = await readAllInChunks<{ id: string; cohort_size: number }>(ids, (chunk, from, to) => sb
      .from('network_aggregates').select('id, cohort_size').in('id', chunk).order('id').range(from, to));
    if (error || !data) {
      console.error('[benchmarks] true band size read failed', error);
      return { ok: false };
    }
    return { ok: true, sizes: new Map(data.map((r) => [r.id, r.cohort_size])) };
  } catch (cause) {
    console.error('[benchmarks] true band size read failed', cause);
    return { ok: false };
  }
}
