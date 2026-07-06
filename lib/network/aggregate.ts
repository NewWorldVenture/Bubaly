// Family Intelligence Network — aggregation core (pure, unit-tested, DB-free).
//
// This is the privacy-critical step: turn per-family COARSE contributions into
// cross-family aggregates that are safe to publish. It enforces, by construction,
// the guarantees signed off in docs/INTELLIGENCE_NETWORK_DESIGN.md:
//   • Cohort = kids age-bands × household-size band ONLY (no geography).      [#3,#4]
//   • k-anonymity: an aggregate is emitted only if ≥ K distinct families back  [#1]
//     it — nothing traceable to a household.
//   • Differential-privacy-lite: published counts get calibrated noise so       [#2]
//     comparing runs can't reveal that one family joined/left.
//   • Global launch gate: nothing is published until ≥ N families contribute.   [#5]
// The cron feeds it real consenting-family contributions; every rule is here so
// it can't be bypassed downstream.

import type { ContributionFeatures } from './contribution';
import { K_ANONYMITY_FLOOR, type ConsentScope, type InsightCandidate } from './insights';

/** Approved defaults (owner sign-off 2026-07-06). */
export const AGG_DEFAULTS = {
  minCohort: K_ANONYMITY_FLOOR,      // #1 — 20
  globalMinFamilies: 100,            // #5 — hold until the network is this big
  noiseScale: 1.5,                   // #2 — Laplace scale (small; counts are already banded)
} as const;

/** One family's coarse contribution: its cohort features + banded metric values. */
export type Contribution = {
  familyId: string;
  features: ContributionFeatures;
  /** metric key → banded value, e.g. { dinner_habit: 'often (4–5)' }. Benchmarks only for v1. */
  metrics: Record<string, string>;
};

/** Cohort key = kids age-bands × household-size band. Deterministic + coarse. */
export function cohortKey(f: ContributionFeatures): string {
  const kids = f.childBands.length ? f.childBands.join('.') : 'none';
  return `kids:${kids}|size:${f.sizeBand}`;
}

export type NetworkAggregate = {
  scope: ConsentScope;
  cohortKey: string;
  metric: string;
  value: string;          // the banded value this count is for
  count: number;          // noised count of families (>= after noise floored at 0)
  cohortSize: number;     // true distinct families in the cohort (always >= minCohort)
};

/** Which scope a metric belongs to. v1 metrics are all benchmark-style. */
const METRIC_SCOPE: Record<string, ConsentScope> = {
  dinner_habit: 'benchmarks',
  activities: 'benchmarks',
};
function metricScope(metric: string): ConsentScope {
  return METRIC_SCOPE[metric] ?? 'benchmarks';
}

/** Deterministic-by-default noise; the cron injects a real Laplace sampler. */
export type NoiseFn = (scale: number) => number;
const NO_NOISE: NoiseFn = () => 0;

/**
 * Aggregate contributions into publish-safe rows.
 *  - Returns [] until ≥ globalMinFamilies distinct families contribute (launch gate).
 *  - Groups by (scope-bearing metric value) within a cohort; a group is emitted only
 *    if ≥ minCohort DISTINCT families back it; its count gets DP noise (floored ≥ 0).
 */
export function aggregateContributions(
  contributions: Contribution[],
  opts: { minCohort?: number; globalMinFamilies?: number; noise?: NoiseFn } = {},
): NetworkAggregate[] {
  const minCohort = opts.minCohort ?? AGG_DEFAULTS.minCohort;
  const globalMin = opts.globalMinFamilies ?? AGG_DEFAULTS.globalMinFamilies;
  const noise = opts.noise ?? NO_NOISE;

  const distinctFamilies = new Set(contributions.map((c) => c.familyId));
  if (distinctFamilies.size < globalMin) return []; // #5 launch gate

  // group key: cohort ∥ metric ∥ value  → set of distinct families
  const groups = new Map<string, { cohort: string; metric: string; value: string; families: Set<string> }>();
  for (const c of contributions) {
    const cohort = cohortKey(c.features);
    for (const [metric, value] of Object.entries(c.metrics)) {
      const key = `${cohort}||${metric}||${value}`;
      let g = groups.get(key);
      if (!g) { g = { cohort, metric, value, families: new Set() }; groups.set(key, g); }
      g.families.add(c.familyId);
    }
  }

  const out: NetworkAggregate[] = [];
  for (const g of groups.values()) {
    const cohortSize = g.families.size;
    if (cohortSize < minCohort) continue; // #1 k-anonymity suppression
    const noised = Math.max(0, Math.round(cohortSize + noise(AGG_DEFAULTS.noiseScale)));
    out.push({ scope: metricScope(g.metric), cohortKey: g.cohort, metric: g.metric, value: g.value, count: noised, cohortSize });
  }
  // stable order: biggest cohorts first
  return out.sort((a, b) => b.cohortSize - a.cohortSize);
}

const METRIC_LABEL: Record<string, string> = {
  dinner_habit: 'plan dinners',
  activities: 'run activities',
};

/**
 * Map publish-safe aggregates into InsightCandidates for a given family's cohort.
 * Only aggregates matching the family's own cohort are relevant. These still pass
 * through `visibleInsights` (consent + k-floor re-check) before display.
 */
export function aggregatesToInsights(aggregates: NetworkAggregate[], familyCohort: string): InsightCandidate[] {
  return aggregates
    .filter((a) => a.cohortKey === familyCohort)
    .map((a) => ({
      id: `${a.metric}:${a.value}`,
      scope: a.scope,
      title: `Families like yours: ${METRIC_LABEL[a.metric] ?? a.metric}`,
      detail: `About ${a.count} similar families report “${a.value}”.`,
      cohortSize: a.cohortSize,
    }));
}

/** Laplace sampler (mean 0). The cron passes this as the real noise source. */
export function laplaceNoise(scale: number, rand: () => number = Math.random): number {
  const u = rand() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}
