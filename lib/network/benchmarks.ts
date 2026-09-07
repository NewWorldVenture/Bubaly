// Household benchmarks — the research/content half of the Intelligence Network
// (pure, DB-free). Turns published `network_aggregates` rows into the shapes the
// admin report, the CSV export and the public /resources/benchmarks page render.
//
// Everything here starts from rows that aggregate.ts already made safe (k-anonymity
// + DP noise + launch gate), and re-applies the k-floor anyway: a row under the
// floor is dropped, never displayed, whatever table it came from.

import { BENCHMARK_METRICS, describeCohort, metricLabel, metricLabelKey, type NetworkAggregate } from './aggregate';
import { K_ANONYMITY_FLOOR, isSuppressed } from './insights';

export type BenchmarkRow = NetworkAggregate & {
  label: string;
  labelKey: string | null;
  childBands: string[];
  sizeBand: string;
};

export type BenchmarkMetricGroup = {
  metric: string;
  label: string;
  labelKey: string | null;
  rows: BenchmarkRow[];
  /** Distinct cohorts this metric is published for. */
  cohorts: number;
};

/** Publication flag shape stored in marketing_settings under BENCHMARKS_PUBLICATION_KEY. */
export const BENCHMARKS_PUBLICATION_KEY = 'benchmarks_public';

/** True only for the explicit `{ enabled: true }` shape — anything else is unpublished. */
export function isBenchmarksPublished(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as { enabled?: unknown }).enabled === true;
}

/**
 * Rows safe to show, described. Drops anything under the k-floor, with a
 * non-positive noised count, or whose cohort key this module cannot parse.
 */
export function benchmarkRows(aggregates: NetworkAggregate[], minCohort: number = K_ANONYMITY_FLOOR): BenchmarkRow[] {
  const out: BenchmarkRow[] = [];
  for (const a of aggregates) {
    if (a.scope !== 'benchmarks') continue;
    if (isSuppressed(a.cohortSize, minCohort)) continue;
    if (!(a.count > 0)) continue;
    const cohort = describeCohort(a.cohortKey);
    if (!cohort) continue;
    out.push({ ...a, label: metricLabel(a.metric), labelKey: metricLabelKey(a.metric), childBands: cohort.childBands, sizeBand: cohort.sizeBand });
  }
  return out.sort((x, y) => y.cohortSize - x.cohortSize || x.cohortKey.localeCompare(y.cohortKey) || x.value.localeCompare(y.value));
}

/** Rows grouped per metric, in catalogue order (unknown metrics last). */
export function groupBenchmarks(aggregates: NetworkAggregate[], minCohort: number = K_ANONYMITY_FLOOR): BenchmarkMetricGroup[] {
  const rows = benchmarkRows(aggregates, minCohort);
  const order = new Map(BENCHMARK_METRICS.map((m, i) => [m.key, i]));
  const byMetric = new Map<string, BenchmarkRow[]>();
  for (const r of rows) {
    const arr = byMetric.get(r.metric) ?? [];
    arr.push(r); byMetric.set(r.metric, arr);
  }
  return [...byMetric.entries()]
    .map(([metric, list]) => ({
      metric, label: metricLabel(metric), labelKey: metricLabelKey(metric), rows: list,
      cohorts: new Set(list.map((r) => r.cohortKey)).size,
    }))
    .sort((a, b) => (order.get(a.metric) ?? 999) - (order.get(b.metric) ?? 999));
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const BENCHMARK_CSV_COLUMNS = [
  'metric', 'metric_label', 'cohort_key', 'kids_age_bands', 'household_size_band',
  'value', 'families_reported', 'cohort_n', 'k_floor', 'computed_at',
] as const;

/**
 * The content-marketing export. `families_reported` is the DP-noised count and
 * `cohort_n` the distinct families behind the row (always ≥ k_floor); there is
 * no per-family column because there is no per-family row anywhere in this data.
 */
export function benchmarksCsv(aggregates: NetworkAggregate[], computedAt: string, minCohort: number = K_ANONYMITY_FLOOR): string {
  const lines = [BENCHMARK_CSV_COLUMNS.join(',')];
  for (const r of benchmarkRows(aggregates, minCohort)) {
    lines.push([
      r.metric, r.label, r.cohortKey, r.childBands.join(' ') || 'none', r.sizeBand,
      r.value, r.count, r.cohortSize, minCohort, computedAt,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
