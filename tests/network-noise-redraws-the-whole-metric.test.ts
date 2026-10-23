// The sticky noise must not turn two nights into a change detector.
//
// N1 / N3 / N6 / N11 / N12 / N16 (re-fix) — the sticky draw was keyed on each
// cell's OWN true count, so a published figure moved only when that band's
// count moved. Compare two nights and every figure that changed was a band the
// household that joined or left occupies, and every figure that did not was a
// band it is not in: the reviewer's probe (70 families and one household T,
// T leaving, 2000 keys) saw only T's cells change in every trial, all three of
// T's bands in 1261. The draw is now keyed on the state of the whole
// (cohort, metric) — every band's true count, withheld bands included — so any
// change inside a metric redraws all of its bands together, and an unchanged
// metric still republishes its figures exactly (N11's averaging protection).
import { describe, expect, it } from 'vitest';
import { aggregateContributions, type Contribution, type NetworkAggregate, type NoiseFn } from '@/lib/network/aggregate';
import { stickyNoise } from '@/lib/network/aggregate-server';

const X = { childBands: ['6–9'], sizeBand: '3–4' };   // T's cohort
const Y = { childBands: [], sizeBand: '1–2' };        // a cohort nobody leaves
const X_KEY = 'kids:6–9|size:3–4';
const Y_KEY = 'kids:none|size:1–2';

function family(id: string, cohort: typeof X, metrics: Record<string, string>): Contribution {
  return {
    familyId: id,
    features: {
      ...cohort, dinnerBand: metrics.dinner_habit, activityBand: metrics.activities,
      choresPerChildBand: null, bedtimeBand: metrics.bedtime_band ?? null, weeklySpendBand: null,
      remindersBand: metrics.reminders_per_week ?? null,
    },
    metrics,
  };
}

/** n families of one cohort, the i-th reporting pick(i) for each metric. */
function many(prefix: string, n: number, cohort: typeof X, pick: (i: number) => Record<string, string>): Contribution[] {
  return Array.from({ length: n }, (_, i) => family(`${prefix}-${i}`, cohort, pick(i)));
}

/**
 * Cohort X, 70 families: dinner 25 rarely / 25 sometimes / 20 often, activities
 * 30 none / 20 1–2 / 20 3–4, reminders 50 none / 20 1–3, and every one of them
 * a bedtime T does not report. Cohort Y: 40 identical families. The gate needs
 * 100, so it stays open after T leaves.
 */
const xFamilies = many('x', 70, X, (i) => ({
  dinner_habit: i < 25 ? 'rarely (0–1)' : i < 50 ? 'sometimes (2–3)' : 'often (4–5)',
  activities: i < 30 ? 'none' : i < 50 ? '1–2' : '3–4',
  reminders_per_week: i < 50 ? 'none' : '1–3',
  bedtime_band: '8–9pm',
}));
const yFamilies = many('y', 40, Y, () => ({ dinner_habit: 'rarely (0–1)', activities: 'none', reminders_per_week: 'none' }));
const T = family('T', X, { dinner_habit: 'sometimes (2–3)', activities: '1–2', reminders_per_week: 'none' });
const T_CELLS = new Set([
  `${X_KEY}|dinner_habit|sometimes (2–3)`, `${X_KEY}|activities|1–2`, `${X_KEY}|reminders_per_week|none`,
]);
const T_METRICS = ['dinner_habit', 'activities', 'reminders_per_week'];

const cellOf = (a: { cohortKey: string; metric: string; value: string }) => `${a.cohortKey}|${a.metric}|${a.value}`;
const published = (rows: NetworkAggregate[]) => new Map(rows.map((a) => [cellOf(a), a.count]));

/** The real aggregation with the real sticky sampler, every raw draw recorded by cell. */
function run(contributions: Contribution[], key: string): { rows: NetworkAggregate[]; counts: Map<string, number>; draws: Map<string, number> } {
  const sticky = stickyNoise(key);
  const draws = new Map<string, number>();
  const noise: NoiseFn = (scale, cell) => {
    const drawn = sticky(scale, cell);
    draws.set(cellOf(cell), drawn);
    return drawn;
  };
  const rows = aggregateContributions(contributions, { noise });
  return { rows, counts: published(rows), draws };
}

describe('one family leaving redraws every band of each metric it reported (and nothing else)', () => {
  const withT = run([...xFamilies, T, ...yFamilies], 'probe-key');
  const withoutT = run([...xFamilies, ...yFamilies], 'probe-key');

  it('publishes the same bands both nights — the comparison is like for like', () => {
    expect([...withoutT.counts.keys()].sort()).toEqual([...withT.counts.keys()].sort());
    // non-vacuity: T's metrics have bands T is NOT in, published beside T's own
    const others = [...withT.counts.keys()].filter((c) => c.startsWith(X_KEY) && T_METRICS.some((m) => c.includes(`|${m}|`)) && !T_CELLS.has(c));
    expect(others.length).toBe(5);
  });

  it('every band of T\'s metrics in T\'s cohort draws anew, the bands T is not in as much as T\'s own', () => {
    for (const metric of T_METRICS) {
      const bands = [...withT.draws.keys()].filter((c) => c.startsWith(`${X_KEY}|${metric}|`));
      expect(bands.length, metric).toBeGreaterThanOrEqual(2);
      for (const band of bands) expect(withoutT.draws.get(band), band).not.toBe(withT.draws.get(band));
    }
  });

  it('a metric T does not report, and a cohort T is not in, draw exactly as before', () => {
    const untouched = [...withT.draws.keys()].filter((c) => c.startsWith(Y_KEY) || c.startsWith(`${X_KEY}|bedtime_band|`));
    expect(untouched.length).toBeGreaterThanOrEqual(4);
    for (const cell of untouched) {
      expect(withoutT.draws.get(cell), cell).toBe(withT.draws.get(cell));
      expect(withoutT.counts.get(cell), cell).toBe(withT.counts.get(cell));
    }
  });
});

describe('the diff of two nights does not single out the leaver\'s bands (the reviewer\'s probe)', () => {
  // 400 keys stand for 400 deployments' secrets: the attack must fail for the
  // secret the server actually has, whichever it is. Fixed keys, so the counts
  // below are exact, not a flaky sample.
  const keys = Array.from({ length: 400 }, (_, i) => `deployment-secret-${i}`);
  let exactlyTsBands = 0;
  let tBandChanged = 0;
  let tBandTrials = 0;
  let otherBandChanged = 0;
  let otherBandTrials = 0;
  let untouchedChanged = 0;
  for (const key of keys) {
    const before = run([...xFamilies, T, ...yFamilies], key).counts;
    const after = run([...xFamilies, ...yFamilies], key).counts;
    const changed = new Set([...before.keys()].filter((cell) => after.get(cell) !== before.get(cell)));
    if (changed.size === T_CELLS.size && [...T_CELLS].every((cell) => changed.has(cell))) exactlyTsBands++;
    for (const cell of before.keys()) {
      const inTsMetric = cell.startsWith(X_KEY) && T_METRICS.some((m) => cell.includes(`|${m}|`));
      if (!inTsMetric) {
        if (changed.has(cell)) untouchedChanged++;
      } else if (T_CELLS.has(cell)) {
        tBandTrials++;
        if (changed.has(cell)) tBandChanged++;
      } else {
        otherBandTrials++;
        if (changed.has(cell)) otherBandChanged++;
      }
    }
  }
  const tRate = tBandChanged / tBandTrials;
  const otherRate = otherBandChanged / otherBandTrials;

  it('a band T is not in changes about as often as one T is in — "it changed" no longer means "T is there"', () => {
    // Keyed per cell, otherRate was 0 and every changed figure was T's.
    expect(otherBandTrials).toBe(keys.length * 5);
    expect(otherRate).toBeGreaterThan(0.6);
    // What is left is how far each count moved: one family in a count of 20 to
    // 50 against noise of sd ≈ 2.1 on each night's draw.
    expect(Math.abs(tRate - otherRate)).toBeLessThan(0.1);
  });

  it('the changed figures are almost never exactly T\'s bands', () => {
    // Keyed per cell, this was every trial in which all three of T's figures
    // moved — the reviewer counted 1261 of 2000.
    expect(exactlyTsBands / keys.length).toBeLessThan(0.01);
  });

  it('and nothing outside T\'s metrics ever moves: an unchanged metric still republishes its figures', () => {
    expect(untouchedChanged).toBe(0);
  });
});

describe('a withheld band is part of its metric\'s state', () => {
  // Dinner in cohort X with a 'most nights' band of 5: complementary
  // suppression withholds it AND the smallest published band ('often', 20),
  // so 'rarely' and 'sometimes' are published. A family leaving the withheld
  // 'most nights' band changed no published count, so keyed per cell no
  // published figure moved — which said the leaver is in a withheld band.
  const withheldBase = [
    ...many('w', 70, X, (i) => ({
      dinner_habit: i < 25 ? 'rarely (0–1)' : i < 50 ? 'sometimes (2–3)' : 'often (4–5)', activities: 'none',
    })),
    ...many('m', 4, X, () => ({ dinner_habit: 'most nights (6–7)', activities: 'none' })),
    ...yFamilies,
  ];
  const leaver = family('L', X, { dinner_habit: 'most nights (6–7)', activities: 'none' });

  it('a family leaving a withheld band redraws the metric\'s published bands', () => {
    const before = run([...withheldBase, leaver], 'probe-key');
    const after = run(withheldBase, 'probe-key');
    const dinner = [...before.draws.keys()].filter((c) => c.startsWith(`${X_KEY}|dinner_habit|`));
    expect(dinner.sort()).toEqual([`${X_KEY}|dinner_habit|rarely (0–1)`, `${X_KEY}|dinner_habit|sometimes (2–3)`]);
    // The published bands' TRUE counts did not move — only the withheld one's did …
    const trueCounts = (rows: NetworkAggregate[]) => rows.filter((a) => a.cohortKey === X_KEY && a.metric === 'dinner_habit').map((a) => [a.value, a.cohortSize]).sort();
    expect(trueCounts(after.rows)).toEqual(trueCounts(before.rows));
    // … and still every published band of the metric draws anew.
    for (const band of dinner) expect(after.draws.get(band), band).not.toBe(before.draws.get(band));
  });
});
