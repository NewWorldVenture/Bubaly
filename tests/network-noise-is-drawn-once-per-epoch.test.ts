// The published figures change once per epoch, and each epoch is one fresh
// sample of every band — no more.
//
// N11-vector-key-reopens-averaging (round 2) — keyed on the whole metric's band
// vector, any change in a (cohort, metric) redrew all of its bands, which kept
// two nights from naming the band a leaver was in; but those vectors change
// almost every night (dinners and reminders are the coming seven days, and the
// network grows), so a band whose own count never moved still drew a fresh
// sample most nights, and the mean of them walked back to the true count: the
// reviewer's probe told whether a known leaver had been in a stable band with
// accuracy 0.685 after one night each side and 0.955 after ninety. A sticky
// draw per cell stops the averaging and brings back the differencing; a fresh
// draw per change stops the differencing and brings back the averaging.
//
// So the figures are published on a fixed epoch (a UTC calendar month):
//  - inside an epoch the cron holds the snapshot — a join, a leave, a band
//    change or nothing at all, the figures are the same every night, so there
//    is nothing to difference and nothing new to average;
//  - the epoch is in the noise key, so the next epoch draws every band afresh,
//    changed or not, and the diff across a boundary names neither the bands
//    nor the cohorts that moved;
//  - the budget is ONE fresh sample per band per epoch, and what averaging
//    still recovers from that budget is measured below, on the real
//    aggregation and the real sampler, and pinned with the comment in
//    lib/network/aggregate-server.ts that states it.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import {
  aggregateContributions, publicationEpoch, PUBLICATION_EPOCH, type Contribution, type NoiseCell,
} from '@/lib/network/aggregate';
import { runNetworkAggregation, stickyNoise } from '@/lib/network/aggregate-server';

// benchmarks-server's own client factory is never used here: every read is
// handed the in-memory database.
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { throw new Error('not in this test'); } }));
const { readBenchmarkAggregates } = await import('@/lib/network/benchmarks-server');

type DB = SupabaseClient<Database>;

describe('the publication epoch', () => {
  it('is a UTC calendar month by default', () => {
    expect(PUBLICATION_EPOCH).toBe('month');
    expect(publicationEpoch(new Date('2026-10-24T03:00:00Z'))).toEqual({ key: '2026-10', start: new Date('2026-10-01T00:00:00Z') });
    expect(publicationEpoch(new Date('2026-10-31T23:59:59.999Z')).key).toBe('2026-10');
    expect(publicationEpoch(new Date('2026-11-01T00:00:00Z')).key).toBe('2026-11');
    expect(publicationEpoch(new Date('2026-12-31T23:59:59Z')).key).toBe('2026-12');
    expect(publicationEpoch(new Date('2027-01-01T00:00:00Z')).key).toBe('2027-01');
  });

  it('an ISO week starts on its Monday and is numbered in the year of its Thursday', () => {
    expect(publicationEpoch(new Date('2026-10-24T03:00:00Z'), 'iso-week')).toEqual({ key: '2026-W43', start: new Date('2026-10-19T00:00:00Z') });
    expect(publicationEpoch(new Date('2026-10-19T00:00:00Z'), 'iso-week').key).toBe('2026-W43');
    expect(publicationEpoch(new Date('2026-10-18T23:59:59Z'), 'iso-week').key).toBe('2026-W42');
    // 1 January 2026 is a Thursday: the week of 29 December 2025 is 2026's first …
    expect(publicationEpoch(new Date('2025-12-29T12:00:00Z'), 'iso-week')).toEqual({ key: '2026-W01', start: new Date('2025-12-29T00:00:00Z') });
    // … and 2026 has 53 weeks, the last holding 1 January 2027.
    expect(publicationEpoch(new Date('2027-01-01T12:00:00Z'), 'iso-week')).toEqual({ key: '2026-W53', start: new Date('2026-12-28T00:00:00Z') });
    expect(publicationEpoch(new Date('2027-01-04T00:00:00Z'), 'iso-week').key).toBe('2027-W01');
  });
});

describe('the sampler is keyed on the epoch', () => {
  const cell: NoiseCell = {
    scope: 'benchmarks', cohortKey: 'kids:6–9|size:1–2', metric: 'dinner_habit', value: 'often (4–5)', cohortSize: 40,
    bandVector: JSON.stringify([['often (4–5)', 40], ['rarely (0–1)', 60]]),
  };

  it('draws the same in one epoch and afresh in the next, for the same band and the same counts', () => {
    const october = stickyNoise('deployment-secret', '2026-10');
    expect(october(1.5, cell)).toBe(october(1.5, { ...cell }));
    expect(stickyNoise('deployment-secret', '2026-10')(1.5, cell)).toBe(october(1.5, cell));
    // Unchanged data, another epoch: a new sample — the budget, spent once per epoch.
    expect(stickyNoise('deployment-secret', '2026-11')(1.5, cell)).not.toBe(october(1.5, cell));
    // Across 200 epochs the draws of one unchanged band are all distinct.
    const draws = new Set(Array.from({ length: 200 }, (_, i) => stickyNoise('deployment-secret', `epoch-${i}`)(1.5, cell)));
    expect(draws.size).toBe(200);
  });
});

describe('the cron publishes once per epoch and holds the snapshot on every other night', () => {
  const SEPTEMBER = new Date('2026-09-08T03:00:00Z');
  const night = (n: number) => new Date(SEPTEMBER.getTime() + n * 86_400_000);
  const OCTOBER = new Date('2026-10-01T03:00:00Z');
  const dayKey = (offset: number, from: Date) => new Date(from.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  let db: InMemorySupabase;

  function household(id: string, opts: { kid?: boolean } = {}) {
    db.seed('families', [{ id, closed_at: null, timezone: 'UTC' }]);
    db.seed('network_consent', [{ family_id: id, enabled: true, scopes: { benchmarks: true }, consented_by: null }]);
    db.seed('family_members', [
      { id: `${id}-p`, family_id: id, user_id: `${id}-parent`, role: 'parent', birthday: '1985-03-03', is_active: true },
      ...(opts.kid === false ? [] : [{ id: `${id}-k`, family_id: id, user_id: null, role: 'child', birthday: '2018-06-01', is_active: true }]),
    ]);
  }
  const published = () => new Map(db.table('network_aggregates').map((r) => [`${r.cohort_key}|${r.metric}|${r.value}`, r.count as number]));
  const trueSize = (cell: string) => db.table('network_aggregates').find((r) => `${r.cohort_key}|${r.metric}|${r.value}` === cell)?.cohort_size;
  const RARELY = 'kids:6–9|size:1–2|dinner_habit|rarely (0–1)';
  const childless = (counts: Map<string, number>) => [...counts].filter(([cell]) => cell.startsWith('kids:none|'));

  beforeEach(() => {
    db = createInMemorySupabase({ uniques: { network_contributions: [['family_id']], network_aggregates: [['scope', 'cohort_key', 'metric', 'value']] } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 120; i++) household(`f-${i}`);
    // 25 more in the same cohort plan four dinners ("often"), so dinner has a
    // band the f-* households are not in; 25 childless ones form a cohort of
    // their own.
    for (let i = 0; i < 25; i++) {
      household(`often-${i}`);
      db.seed('meal_plans', [SEPTEMBER, OCTOBER].flatMap((from) => [1, 2, 3, 4].map((d) => ({ family_id: `often-${i}`, meal_type: 'dinner', plan_date: dayKey(d, from) }))));
    }
    for (let i = 0; i < 25; i++) household(`nokid-${i}`, { kid: false });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('a leave, a band change and a join inside the epoch change no published figure, night after night', async () => {
    const first = await runNetworkAggregation(db as unknown as DB, SEPTEMBER);
    expect(first).toMatchObject({ ok: true, epoch: '2026-09', held: false });
    const snapshot = published();
    expect(snapshot.size).toBeGreaterThanOrEqual(8);
    expect(trueSize(RARELY)).toBe(120);

    // Night 2: f-0 leaves, an "often" household plans nothing, a household joins.
    db.replace('network_consent', db.table('network_consent').filter((r) => r.family_id !== 'f-0'));
    db.replace('meal_plans', db.table('meal_plans').filter((r) => r.family_id !== 'often-0'));
    household('joiner');
    for (let n = 1; n <= 20; n++) {
      const result = await runNetworkAggregation(db as unknown as DB, night(n));
      expect(result, `night ${n}`).toMatchObject({ ok: true, epoch: '2026-09', held: true, aggregates: snapshot.size });
      // Every figure, every night: nothing to difference, nothing to average.
      expect(published(), `night ${n}`).toEqual(snapshot);
      // The run stands behind the snapshot (the 36-hour rule still sees a live cron) …
      expect(db.table('network_aggregates').every((r) => r.computed_at === night(n).toISOString()), `night ${n}`).toBe(true);
    }
    // … and still forgets the leaver's own row at once; its share of the
    // figures goes with the epoch.
    expect(db.table('network_contributions').some((r) => r.family_id === 'f-0')).toBe(false);
    expect(trueSize(RARELY)).toBe(120);

    // The readers' 36-hour rule is unchanged by the epoch: three weeks into
    // it, the held snapshot is what the public page, the export and the
    // report read …
    const read = await readBenchmarkAggregates(db as unknown as DB, new Date(night(20).getTime() + 9 * 3_600_000));
    expect(read.ok && new Map(read.aggregates.map((a) => [`${a.cohortKey}|${a.metric}|${a.value}`, a.count]))).toEqual(snapshot);
    // … and once no run has stood behind it for a day and a half, nothing is.
    const stale = await readBenchmarkAggregates(db as unknown as DB, new Date(night(20).getTime() + 37 * 3_600_000));
    expect(stale).toMatchObject({ ok: true, aggregates: [] });
  });

  it('a second publish inside one epoch (the snapshot gone, as overlapping runs could leave it) draws the same figures for the same state', async () => {
    expect(await runNetworkAggregation(db as unknown as DB, SEPTEMBER)).toMatchObject({ ok: true, held: false });
    const snapshot = published();
    db.replace('network_aggregates', []);
    // An hour later: the same households, the same week, so the same state.
    expect(await runNetworkAggregation(db as unknown as DB, new Date(SEPTEMBER.getTime() + 3_600_000))).toMatchObject({ ok: true, epoch: '2026-09', held: false });
    expect(published()).toEqual(snapshot);
  });

  it('the first run of the next epoch rebuilds the figures without the leaver, and every band draws afresh', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `deployment-secret-${i}`);
    const consents = db.table('network_consent').map((r) => ({ ...r }));
    let untouchedRedrawn = 0;
    for (const key of keys) {
      vi.stubEnv('INTERNAL_SECRET', key);
      db.replace('network_aggregates', []);
      db.replace('network_consent', consents.map((r) => ({ ...r })));
      expect((await runNetworkAggregation(db as unknown as DB, SEPTEMBER)).ok).toBe(true);
      const september = published();
      db.replace('network_consent', consents.filter((r) => r.family_id !== 'f-0').map((r) => ({ ...r })));
      const result = await runNetworkAggregation(db as unknown as DB, OCTOBER);
      expect(result).toMatchObject({ ok: true, epoch: '2026-10', held: false });
      expect(trueSize(RARELY)).toBe(119);
      expect(db.table('network_aggregates').every((r) => r.computed_at === OCTOBER.toISOString())).toBe(true);
      // The childless cohort's true counts did not move, and its figures are
      // still a new sample: a boundary's diff does not say which cohort changed.
      const before = childless(september);
      expect(before.length).toBeGreaterThanOrEqual(3);
      if (JSON.stringify(childless(published())) !== JSON.stringify(before)) untouchedRedrawn++;
    }
    // Keyed without the epoch, this cohort republished exactly under every key.
    expect(untouchedRedrawn).toBeGreaterThanOrEqual(keys.length - 1);
  });
});

describe('what averaging recovers from the budget (the reviewer\'s probe, per epoch)', () => {
  // Cohort X holds a stable "often" dinner band of 25, sixty siblings of whom
  // one changes band every epoch (so the metric's vector changes every epoch,
  // as dinners and reminders do in production), and a second cohort of 40.
  // Household T leaves at a known boundary. The attacker compares the mean
  // "often" figure of the E epochs before with the E epochs after and says T
  // was in "often" when it fell by more than 0.5. 400 fixed keys stand for 400
  // deployments' secrets, so the accuracies are exact, not a flaky sample.
  const X = { childBands: ['6–9'], sizeBand: '3–4' };
  const Y = { childBands: [], sizeBand: '1–2' };
  const OFTEN = 'often (4–5)';
  const OTHER = ['rarely (0–1)', 'sometimes (2–3)'];
  const SIDE = 52;
  const KEYS = 400;
  const WINDOWS = [1, 4, 12, 52] as const;
  /** What the probe measures — and what lib/network/aggregate-server.ts says it measures. */
  const MEASURED: Record<(typeof WINDOWS)[number], number> = { 1: 0.581, 4: 0.613, 12: 0.71, 52: 0.889 };
  const correct = new Map<number, number>(WINDOWS.map((w) => [w, 0]));
  let trials = 0;
  const accuracy = (w: number) => +(correct.get(w)! / trials).toFixed(3);

  beforeAll(() => {
    const epochs = Array.from({ length: 2 * SIDE }, (_, i) => publicationEpoch(new Date(Date.UTC(2027, i, 15))).key);
    const family = (id: string, cohort: typeof X, dinner: string): Contribution => ({
      familyId: id,
      features: { ...cohort, dinnerBand: dinner, activityBand: 'none', choresPerChildBand: null, bedtimeBand: null, weeklySpendBand: null, remindersBand: null },
      metrics: { dinner_habit: dinner, activities: 'none' },
    });
    let seed = 1013;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const siblings = Array.from({ length: 60 }, (_, i) => OTHER[i % 2]);
    const stable = Array.from({ length: 25 }, (_, i) => family(`often-${i}`, X, OFTEN));
    const other = Array.from({ length: 40 }, (_, i) => family(`y-${i}`, Y, OTHER[0]));
    const base = epochs.map(() => {
      const i = Math.floor(rand() * siblings.length);
      siblings[i] = OTHER[siblings[i] === OTHER[0] ? 1 : 0];
      return [...stable, ...siblings.map((band, j) => family(`sibling-${j}`, X, band)), ...other];
    });
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    for (let k = 0; k < KEYS; k++) {
      for (const tInOften of [true, false]) {
        const tBand = tInOften ? OFTEN : OTHER[k % 2];
        // The published "often" figure every epoch, T present for the first SIDE.
        const figures = epochs.map((epoch, e) => {
          const contributions = e < SIDE ? [...base[e], family('T', X, tBand)] : base[e];
          const rows = aggregateContributions(contributions, { noise: stickyNoise(`deployment-secret-${k}`, epoch) });
          return rows.find((a) => a.cohortKey === 'kids:6–9|size:3–4' && a.metric === 'dinner_habit' && a.value === OFTEN)!.count;
        });
        for (const w of WINDOWS) {
          const step = mean(figures.slice(SIDE, SIDE + w)) - mean(figures.slice(SIDE - w, SIDE));
          if ((step < -0.5) === tInOften) correct.set(w, correct.get(w)! + 1);
        }
        trials++;
      }
    }
  }, 300_000);

  it('measures the stated accuracy after 1, 4, 12 and 52 epochs each side', () => {
    for (const w of WINDOWS) expect(accuracy(w), `${w} epochs each side`).toBeCloseTo(MEASURED[w], 2);
  });

  it('rises with every epoch watched: the budget bounds averaging, it does not defeat it', () => {
    for (let i = 1; i < WINDOWS.length; i++) expect(accuracy(WINDOWS[i])).toBeGreaterThan(accuracy(WINDOWS[i - 1]));
  });

  it('is what the sampler\'s comment states, so the comment cannot drift from the code', () => {
    const comment = readFileSync('lib/network/aggregate-server.ts', 'utf8').replace(/\n\s*\*\s?/g, ' ').replace(/\s+/g, ' ');
    const stated = /accuracy ([\d.]+) after 1 epoch each side, ([\d.]+) after 4, ([\d.]+) after 12 and ([\d.]+) after 52/.exec(comment);
    expect(stated).not.toBeNull();
    expect(stated!.slice(1).map(Number)).toEqual(WINDOWS.map((w) => MEASURED[w]));
    // … and states the budget those figures are measured against, and that it
    // bounds averaging rather than defeating it.
    expect(comment).toContain('The BUDGET is one fresh sample per published band per epoch');
    expect(comment).toContain('averaging epochs still converges on the true count');
    expect(comment).not.toMatch(/repetition adds nothing|averaging (many nights )?recovers nothing/);
  });
});
