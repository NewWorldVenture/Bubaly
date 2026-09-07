// "Families like yours …" — the one honest comparison line in the weekly digest.
//
// Pure and DB-free. Takes what the nightly aggregation already persisted for a
// family (its network_contributions row: cohort key + banded metrics) and the
// k-anonymized aggregates for that cohort, and turns them into ONE sentence —
// or null. Null is the common answer and the honest one: no consent, no
// benchmarks scope, no contribution row yet, a cohort still under the floor, or
// no aggregate that says anything about this family. Nothing is ever inferred
// from raw data here; every number came out of aggregate.ts, already noised.

import { metricLabel, metricLabelKey, type NetworkAggregate } from './aggregate';
import { K_ANONYMITY_FLOOR, isSuppressed, type ConsentState } from './insights';

export type CompareLine = {
  metric: string;
  /** English label ("dinner planning"); `labelKey` is the catalogue key for the reader's language. */
  label: string;
  labelKey: string;
  /** The family's own band for this metric. */
  familyValue: string;
  /** The most common band in the cohort (equals familyValue when `matches`). */
  cohortValue: string;
  /** DP-noised count of families behind `cohortValue` — the only number a person sees. */
  count: number;
  /** True distinct families behind that band (≥ floor by construction); never rendered. */
  cohortSize: number;
  /** Whether the family sits in the cohort's most common band. */
  matches: boolean;
};

export type CompareLineInput = {
  consent: ConsentState;
  /** The family's cohort key from its network_contributions row, or null when it has not contributed. */
  cohortKey: string | null;
  /** The family's own banded metrics from that same row. */
  metrics: Record<string, string>;
};

/**
 * One comparison, or null. Picks the metric with the most families behind it
 * so the line is the best-supported thing the network can say, and prefers a
 * metric the family shares with the majority — a benchmark should reassure or
 * inform, never single a family out. Every aggregate is re-checked against the
 * k-floor and the benchmarks scope as defense in depth.
 */
export function compareLine(input: CompareLineInput, aggregates: NetworkAggregate[], minCohort: number = K_ANONYMITY_FLOOR): CompareLine | null {
  if (!input.consent.enabled || input.consent.scopes.benchmarks !== true) return null;
  if (!input.cohortKey) return null;

  const safe = aggregates.filter((a) =>
    a.scope === 'benchmarks' && a.cohortKey === input.cohortKey && !isSuppressed(a.cohortSize, minCohort) && a.count > 0);
  if (safe.length === 0) return null;

  let best: CompareLine | null = null;
  for (const [metric, familyValue] of Object.entries(input.metrics)) {
    if (!familyValue) continue;
    const forMetric = safe.filter((a) => a.metric === metric);
    if (forMetric.length === 0) continue;
    const modal = forMetric.reduce((top, a) => (a.cohortSize > top.cohortSize ? a : top));
    const labelKey = metricLabelKey(metric);
    if (!labelKey) continue; // an unknown metric cannot be named to a person
    const candidate: CompareLine = {
      metric,
      label: metricLabel(metric),
      labelKey,
      familyValue,
      cohortValue: modal.value,
      count: modal.count,
      cohortSize: modal.cohortSize,
      matches: modal.value === familyValue,
    };
    if (!best || rank(candidate) > rank(best)) best = candidate;
  }
  return best;
}

/** Shared-with-majority first, then the better-supported cohort. */
function rank(line: CompareLine): number {
  return (line.matches ? 1_000_000 : 0) + line.cohortSize;
}

/**
 * The sentence, in the reader's language. `t` is the app translator; the two
 * catalogue keys carry the wording so the digest never hardcodes English.
 */
export function renderCompareLine(line: CompareLine | null, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (!line) return null;
  const params = {
    count: line.count,
    label: t(line.labelKey),
    value: line.cohortValue,
    familyValue: line.familyValue,
  };
  return line.matches ? t('network.compareLineSame', params) : t('network.compareLineDiffers', params);
}
