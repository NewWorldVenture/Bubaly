// Family Intelligence Network — aggregation core (pure, unit-tested, DB-free).
//
// This is the privacy-critical step: turn per-family COARSE contributions into
// cross-family aggregates that are safe to publish. It enforces, by construction,
// the guarantees signed off in docs/INTELLIGENCE_NETWORK_DESIGN.md:
//   • Cohort = kids age-bands × household-size band ONLY (no geography).      [#3,#4]
//   • k-anonymity: an aggregate is emitted only if ≥ K distinct families back  [#1]
//     it — nothing traceable to a household — and the bands withheld beside it
//     in its (cohort, metric) never add up to fewer than K families either
//     (complementary suppression), so a withheld band's size cannot be read
//     off as "everyone minus the rest".
//   • Differential-privacy-lite: published counts get calibrated noise so       [#2]
//     comparing runs can't reveal that one family joined/left. The cron's noise
//     is STICKY — one draw per (cell, true count), not one per run — so a night
//     that changed nothing publishes the same number, and averaging many nights
//     recovers nothing (see aggregate-server.ts).
//   • Global launch gate: nothing is published until ≥ N families contribute.   [#5]
// The cron feeds it real consenting-family contributions; every rule is here so
// it can't be bypassed downstream.

import { bandLabel, type ContributionFeatures } from './contribution';
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
  /** metric key → banded value, e.g. { dinner_habit: 'often (4–5)' }. See BENCHMARK_METRICS. */
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
  /**
   * TRUE distinct families behind this (cohort, metric, value) band — not the
   * cohort's size, and never a number a person or a file is shown. It is the
   * figure `count` is noised to hide: printed beside it the noise cancels, and
   * two nights' difference is exactly who joined or left. Server-side only, for
   * the k-floor (always >= minCohort when written).
   */
  cohortSize: number;
};

/**
 * The benchmark metric catalogue — every metric the network publishes, with the
 * consent scope it belongs to and how it is named to a person. Module-level data:
 * English label plus a catalogue key, so both the app and the public page can
 * render the same metric in the reader's language. Values are bands from
 * contribution.ts, never raw numbers.
 */
export const BENCHMARK_METRICS: { key: string; scope: ConsentScope; label: string; labelKey: string }[] = [
  { key: 'dinner_habit', scope: 'benchmarks', label: 'dinner planning', labelKey: 'network.metricDinnerPlanning' },
  { key: 'activities', scope: 'benchmarks', label: 'activities', labelKey: 'network.metricActivities' },
  { key: 'chores_per_child', scope: 'benchmarks', label: 'chores per child', labelKey: 'network.metricChoresPerChild' },
  { key: 'bedtime_band', scope: 'benchmarks', label: 'typical bedtime', labelKey: 'network.metricTypicalBedtime' },
  { key: 'weekly_spend_band', scope: 'benchmarks', label: 'weekly spend', labelKey: 'network.metricWeeklySpend' },
  { key: 'reminders_per_week', scope: 'benchmarks', label: 'reminders per week', labelKey: 'network.metricRemindersPerWeek' },
];

/** Which scope a metric belongs to. Every catalogued metric is benchmark-style. */
const METRIC_SCOPE: Record<string, ConsentScope> = Object.fromEntries(BENCHMARK_METRICS.map((m) => [m.key, m.scope]));
function metricScope(metric: string): ConsentScope {
  return METRIC_SCOPE[metric] ?? 'benchmarks';
}

/** The scopes a family can contribute anything under: those the catalogue has a metric for. */
const CONTRIBUTING_SCOPES: ConsentScope[] = [...new Set(BENCHMARK_METRICS.map((m) => m.scope))];

/**
 * Whether a consent row contributes anything at all. A family that joined with
 * no scope switched on — or only `timing` / `recommendations`, which no metric
 * belongs to — contributes nothing: its household is not read, no row is
 * stored for it, and it does not count toward the launch gate. The module
 * tells that family it is "Currently private", and this is what makes it so.
 */
export function contributesToNetwork(scopes: Partial<Record<ConsentScope, boolean>> | null | undefined): boolean {
  return CONTRIBUTING_SCOPES.some((scope) => scopes?.[scope] === true);
}

/**
 * How long a published aggregate may be read without a newer run behind it:
 * the nightly cron plus a day's margin. A family that withdrew is still inside
 * the aggregates until a run gets all the way to republishing, so a run that
 * keeps failing must not keep publishing them — past this age every reader
 * treats the rows as absent (its existing empty state), never as current.
 */
export const AGGREGATE_MAX_AGE_MS = 36 * 3_600_000;

/** The oldest `computed_at` a reader may still show, as of `now`. */
export function freshAggregatesSince(now: Date = new Date()): string {
  return new Date(now.getTime() - AGGREGATE_MAX_AGE_MS).toISOString();
}

/** English label for a metric (the catalogue key is `metricLabelKey`). */
export function metricLabel(metric: string): string {
  return BENCHMARK_METRICS.find((m) => m.key === metric)?.label ?? metric;
}

/** Catalogue key for a metric's label, or null for a metric the catalogue does not know. */
export function metricLabelKey(metric: string): string | null {
  return BENCHMARK_METRICS.find((m) => m.key === metric)?.labelKey ?? null;
}

/**
 * The two coarse dimensions a cohort key encodes — parsed back out for display
 * ("families with children 6–9 and 10–13 in a household of 3–4"). Returns null
 * for a key this module did not produce, so a corrupt row is never described.
 */
export function describeCohort(key: string): { childBands: string[]; sizeBand: string } | null {
  const m = /^kids:([^|]+)\|size:(.+)$/.exec(key);
  if (!m) return null;
  const childBands = m[1] === 'none' ? [] : m[1].split('.').filter(Boolean);
  return { childBands, sizeBand: m[2] };
}

/**
 * Granular-consent gate at CONTRIBUTION time: keep only the metrics whose scope
 * the family explicitly toggled on. This is the write-side half of the scopes
 * guarantee — the read side (visibleInsights) already filters what a family
 * SEES; this ensures a family never CONTRIBUTES to a scope it didn't opt into.
 */
export function filterMetricsByScopes(
  metrics: Record<string, string>,
  scopes: Partial<Record<ConsentScope, boolean>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [metric, value] of Object.entries(metrics)) {
    if (scopes[metricScope(metric)] === true) out[metric] = value;
  }
  return out;
}

/** The cell a noise draw is for — what a sticky sampler keys its draw on. */
export type NoiseCell = { scope: ConsentScope; cohortKey: string; metric: string; value: string; cohortSize: number };

/**
 * Deterministic-by-default noise; the cron injects a real Laplace sampler. The
 * cell is handed over so the sampler can be STICKY — the same draw for the same
 * cell at the same true count. A sampler that ignores it draws afresh on every
 * call, and a fresh draw every night on unchanged data is a new sample of the
 * same number: the mean of a month of them is the true count.
 */
export type NoiseFn = (scale: number, cell: NoiseCell) => number;
const NO_NOISE: NoiseFn = () => 0;

type Group = { cohort: string; metric: string; value: string; families: Set<string> };

/**
 * Complementary suppression for one (cohort, metric): which bands to withhold.
 *
 * The k-floor alone is per band, and that is not enough. Every benchmarks
 * family reports dinner, activities and reminders, so a cohort's total is the
 * sum of any one of those metrics' bands; with every other band of a metric
 * published, the withheld remainder is that total minus what is shown — an
 * exact count of 1 to 19 families, or the news that a single household differs
 * from all the rest (the probe: reminders "none" 41 and activities "none" 40
 * said exactly one family in that cohort has an activity). So the withheld
 * bands of a metric must themselves add up to at least the floor: while they
 * do not, the smallest published band is withheld too. A metric then shows
 * every band, or hides at least K families across at least two bands — never
 * a remainder small enough to point at someone.
 */
function withheldBands(bands: Group[], minCohort: number): Set<Group> {
  const withheld = new Set(bands.filter((b) => b.families.size < minCohort));
  let hidden = [...withheld].reduce((n, b) => n + b.families.size, 0);
  if (hidden === 0 || hidden >= minCohort) return withheld;
  const shown = bands
    .filter((b) => !withheld.has(b))
    .sort((a, b) => a.families.size - b.families.size || a.value.localeCompare(b.value));
  for (const band of shown) {
    withheld.add(band);
    hidden += band.families.size;
    if (hidden >= minCohort) break;
  }
  return withheld;
}

/**
 * Aggregate contributions into publish-safe rows.
 *  - Returns [] until ≥ globalMinFamilies distinct families contribute (launch gate).
 *  - Groups by (scope-bearing metric value) within a cohort; a group is emitted only
 *    if ≥ minCohort DISTINCT families back it and the bands withheld beside it in
 *    its (cohort, metric) total at least minCohort; its count gets DP noise
 *    (floored ≥ 0).
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
  const groups = new Map<string, Group>();
  for (const c of contributions) {
    const cohort = cohortKey(c.features);
    for (const [metric, value] of Object.entries(c.metrics)) {
      const key = `${cohort}||${metric}||${value}`;
      let g = groups.get(key);
      if (!g) { g = { cohort, metric, value, families: new Set() }; groups.set(key, g); }
      g.families.add(c.familyId);
    }
  }

  // The bands of each (cohort, metric), so the floor applies to what is
  // withheld as well as to what is shown.
  const cells = new Map<string, Group[]>();
  for (const g of groups.values()) {
    const key = `${g.cohort}||${g.metric}`;
    const bands = cells.get(key);
    if (bands) bands.push(g); else cells.set(key, [g]);
  }

  const out: NetworkAggregate[] = [];
  for (const bands of cells.values()) {
    const withheld = withheldBands(bands, minCohort); // #1 k-anonymity + complementary suppression
    for (const g of bands) {
      if (withheld.has(g)) continue;
      const cohortSize = g.families.size;
      const scope = metricScope(g.metric);
      const drawn = noise(AGG_DEFAULTS.noiseScale, { scope, cohortKey: g.cohort, metric: g.metric, value: g.value, cohortSize });
      const noised = Math.max(0, Math.round(cohortSize + drawn));
      out.push({ scope, cohortKey: g.cohort, metric: g.metric, value: g.value, count: noised, cohortSize });
    }
  }
  // stable order: biggest cohorts first (the cron's write order; nothing renders it)
  return out.sort((a, b) => b.cohortSize - a.cohortSize);
}

/**
 * Map publish-safe aggregates into InsightCandidates for a given family's cohort.
 * Only aggregates matching the family's own cohort are relevant. On the way to a
 * browser they pass through `publishableInsights` (the k-floor re-check, on the
 * server, which also drops the true size).
 *
 * Pass `null` for NO cohort filter — the public benchmarks page renders every
 * published row, so its ids carry the cohort key to stay unique. Either way the
 * rows are already k-anonymized and DP-noised: the detail exposes the noised
 * count, never the true band size, which rides along only for the floor.
 *
 * `t` is optional and is how the two sentences reach a reader in their own
 * language: the caller that renders (the intelligence page) passes the app
 * translator, and callers that only need the ids (the public page's safety
 * re-check) leave it out and get the English wording.
 */
export function aggregatesToInsights(
  aggregates: NetworkAggregate[],
  familyCohort: string | null,
  t?: (key: string, params?: Record<string, string | number>) => string,
): InsightCandidate[] {
  return aggregates
    .filter((a) => familyCohort === null || a.cohortKey === familyCohort)
    .map((a) => {
      const labelKey = metricLabelKey(a.metric);
      const label = t && labelKey ? t(labelKey) : metricLabel(a.metric);
      return {
        id: familyCohort === null ? `${a.cohortKey}:${a.metric}:${a.value}` : `${a.metric}:${a.value}`,
        scope: a.scope,
        title: t ? t('network.insightTitle', { metric: label }) : `Families like yours: ${label}`,
        // The BAND is a word the reader sees inside a translated sentence, so it
        // is translated too — an English band in a German sentence is the bug
        // labelKeys alone did not fix.
        detail: t
          ? t('network.insightDetail', { count: a.count, value: bandLabel(a.metric, a.value, t) })
          : `About ${a.count} similar families report “${a.value}”.`,
        count: a.count,
        cohortSize: a.cohortSize,
      };
    });
}

/** Laplace sampler (mean 0). The cron passes this as the real noise source. */
export function laplaceNoise(scale: number, rand: () => number = Math.random): number {
  const u = rand() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}
