import { describe, it, expect } from 'vitest';
import {
  cohortKey, aggregateContributions, aggregatesToInsights, laplaceNoise, filterMetricsByScopes,
  AGG_DEFAULTS, type Contribution,
} from '@/lib/network/aggregate';
import type { ContributionFeatures } from '@/lib/network/contribution';

const feat = (childBands: string[], sizeBand: string): ContributionFeatures => ({
  childBands, sizeBand, dinnerBand: 'often (4–5)', activityBand: '3–4',
  choresPerChildBand: '1–2', bedtimeBand: '8–9pm', weeklySpendBand: '100–250', remindersBand: '1–3',
});

// Build N families in one cohort, all reporting the same dinner_habit.
function cohortOf(n: number, prefix: string, value = 'often (4–5)'): Contribution[] {
  return Array.from({ length: n }, (_, i) => ({
    familyId: `${prefix}-${i}`,
    features: feat(['6–9'], '3–4'),
    metrics: { dinner_habit: value },
  }));
}

describe('cohortKey', () => {
  it('is kids age-bands × household-size only (no geography)', () => {
    expect(cohortKey(feat(['6–9', '10–13'], '3–4'))).toBe('kids:6–9.10–13|size:3–4');
    expect(cohortKey(feat([], '1–2'))).toBe('kids:none|size:1–2');
  });
});

describe('aggregateContributions — launch gate (#5)', () => {
  it('returns nothing until the global family threshold is met', () => {
    const few = cohortOf(50, 'f'); // 50 < 100 default gate
    expect(aggregateContributions(few)).toEqual([]);
  });
  it('publishes once the gate is cleared', () => {
    const many = cohortOf(120, 'f');
    const agg = aggregateContributions(many);
    expect(agg.length).toBeGreaterThan(0);
  });
});

describe('aggregateContributions — k-anonymity (#1)', () => {
  it('suppresses cohorts/values with fewer than K families', () => {
    // 120 families total (clears gate); 110 report value A, 10 report value B.
    const contributions: Contribution[] = [
      ...cohortOf(110, 'a', 'often (4–5)'),
      ...cohortOf(10, 'b', 'rarely (0–1)'),
    ];
    const agg = aggregateContributions(contributions);
    expect(agg.some((a) => a.value === 'often (4–5)')).toBe(true);   // 110 >= 20
    expect(agg.some((a) => a.value === 'rarely (0–1)')).toBe(false); // 10 < 20 → suppressed
    for (const a of agg) expect(a.cohortSize).toBeGreaterThanOrEqual(AGG_DEFAULTS.minCohort);
  });

  it('counts DISTINCT families, not rows', () => {
    const dup = [...cohortOf(120, 'x'), ...cohortOf(120, 'x')]; // same familyIds twice
    const agg = aggregateContributions(dup);
    expect(agg[0].cohortSize).toBe(120);
  });
});

describe('aggregateContributions — DP noise (#2)', () => {
  it('applies the injected noise fn to the published count (not the true cohortSize)', () => {
    const agg = aggregateContributions(cohortOf(120, 'f'), { noise: () => 3 });
    expect(agg[0].cohortSize).toBe(120);   // truth preserved internally
    expect(agg[0].count).toBe(123);        // published count is noised
  });
  it('floors the noised count at 0', () => {
    const agg = aggregateContributions(cohortOf(120, 'f'), { noise: () => -1000 });
    expect(agg[0].count).toBe(0);
  });
});

describe('aggregatesToInsights', () => {
  it('maps only aggregates in the family’s own cohort', () => {
    const agg = aggregateContributions(cohortOf(120, 'f'));
    const insights = aggregatesToInsights(agg, 'kids:6–9|size:3–4');
    expect(insights.length).toBeGreaterThan(0);
    expect(insights[0].scope).toBe('benchmarks');
    expect(insights[0].cohortSize).toBe(120);
    // a different cohort sees nothing
    expect(aggregatesToInsights(agg, 'kids:none|size:1–2')).toEqual([]);
  });

  it('privacy invariant: the human-readable detail exposes the DP-noised count, never the true cohort size', () => {
    // Force noise so noised count (123) differs from the true cohortSize (120).
    const agg = aggregateContributions(cohortOf(120, 'f'), { noise: () => 3 });
    const insights = aggregatesToInsights(agg, 'kids:6–9|size:3–4');
    expect(insights[0].detail).toContain('123');       // the noised count is shown
    expect(insights[0].detail).not.toContain('120');   // the true size is never shown
    expect(insights[0].cohortSize).toBe(120);          // true size retained only for the k-floor gate
  });
});

describe('filterMetricsByScopes — write-side granular consent', () => {
  const metrics = { dinner_habit: 'often (4–5)', activities: '3–4' };

  it('drops all metrics when their scope is not opted in', () => {
    // dinner_habit + activities are 'benchmarks'; family opted into timing only.
    expect(filterMetricsByScopes(metrics, { timing: true })).toEqual({});
  });

  it('keeps metrics whose scope is explicitly true', () => {
    expect(filterMetricsByScopes(metrics, { benchmarks: true })).toEqual(metrics);
  });

  it('treats missing/false scope values as not consented', () => {
    expect(filterMetricsByScopes(metrics, {})).toEqual({});
    expect(filterMetricsByScopes(metrics, { benchmarks: false })).toEqual({});
  });

  it('a scope-stripped contribution adds nothing to aggregation', () => {
    // 120 families opted into benchmarks + 120 who only opted into timing:
    // only the benchmark-consenting families should back the aggregate.
    const consenting = cohortOf(120, 'yes');
    const timingOnly = cohortOf(120, 'no').map((c) => ({
      ...c, metrics: filterMetricsByScopes(c.metrics, { timing: true }),
    }));
    const agg = aggregateContributions([...consenting, ...timingOnly]);
    expect(agg[0].cohortSize).toBe(120); // not 240
  });
});

describe('laplaceNoise', () => {
  it('is 0 at the distribution centre and symmetric around it', () => {
    expect(laplaceNoise(1.5, () => 0.5)).toBeCloseTo(0, 10);
    expect(laplaceNoise(1.5, () => 0.9)).toBeGreaterThan(0);
    expect(laplaceNoise(1.5, () => 0.1)).toBeLessThan(0);
  });
});
