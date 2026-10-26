// The nightly network aggregation, end to end against the in-memory database:
// who it reads, what it keeps, what it forgets, and what its noise reveals.
//
// N14 / N17 — a family that joined with every scope off ("Currently private")
//   was read in full, stored with all its bands, and COUNTED toward the
//   100-family launch gate: 30 benchmark families plus 70 who only flipped the
//   master switch opened publication for the 30.
// N7  — consents a child or teen wrote before 0353 were honoured, because
//   nothing asked who wrote them.
// N8  — the prune of withdrawn families ran after the source reads and the
//   upserts, so a run failing in either kept the withdrawn family's row.
// N11 / N12 — fresh Laplace noise on every run: averaging nights recovered the
//   true counts. Now the figures are published once per epoch and held on
//   every other night of it, so nights inside an epoch add no sample; the
//   per-epoch budget is pinned in tests/network-noise-is-drawn-once-per-epoch.test.ts.
// N13 — reminders were counted from the legacy table only.
// N15 — dinners over eight days and spend over twenty-nine, on Greenwich's day.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { runNetworkAggregation, stickyNoise } from '@/lib/network/aggregate-server';

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-09-08T12:00:00Z'); // a Tuesday
const dayKey = (offset: number, from = NOW) => new Date(from.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const iso = (offset: number, from = NOW) => new Date(from.getTime() + offset * 86_400_000).toISOString();

let db: InMemorySupabase;

/** One open, consenting household: a parent and a child of six to nine. */
function household(id: string, opts: { scopes?: Record<string, boolean>; consentedBy?: string | null; tz?: string; kid?: boolean } = {}) {
  db.seed('families', [{ id, closed_at: null, timezone: opts.tz ?? 'UTC' }]);
  db.seed('network_consent', [{ family_id: id, enabled: true, scopes: opts.scopes ?? { benchmarks: true }, consented_by: opts.consentedBy ?? null }]);
  db.seed('family_members', [
    { id: `${id}-p`, family_id: id, user_id: `${id}-parent`, role: 'parent', birthday: '1985-03-03', is_active: true },
    ...(opts.kid === false ? [] : [{ id: `${id}-k`, family_id: id, user_id: null, role: 'child', birthday: '2018-06-01', is_active: true }]),
  ]);
}

/** The client, recording every family id a read names. */
function recording(inner: InMemorySupabase): { db: DB; namedFamilies: Set<string> } {
  const namedFamilies = new Set<string>();
  const proxied = new Proxy(inner as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const wrap = (builder: object): object => new Proxy(builder, {
          get(b, key, r) {
            const value = Reflect.get(b, key, r);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              if (key === 'in' && args[0] === 'family_id' && Array.isArray(args[1]) && table !== 'network_contributions') {
                for (const id of args[1] as string[]) namedFamilies.add(id);
              }
              const out = (value as (...a: unknown[]) => unknown).call(b, ...args);
              return out === b ? r : out;
            };
          },
        });
        return wrap((target as InMemorySupabase).from(table) as unknown as object);
      };
    },
  });
  return { db: proxied as unknown as DB, namedFamilies };
}

/**
 * The client, with every read of `table` answered by a transport error — or,
 * given `column`, only the reads that filter on that column.
 */
function refusing(inner: InMemorySupabase, table: string, column?: string): DB {
  const refused = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'eq', 'gt', 'gte', 'lt', 'lte', 'or', 'order', 'range']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'connection reset' } });
    return chain;
  };
  return new Proxy(inner as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (name: string) => {
        const builder = (target as InMemorySupabase).from(name);
        if (name !== table) return builder;
        if (!column) return refused();
        return new Proxy(builder as object, {
          get(b, key, r) {
            const value = Reflect.get(b, key, r);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              if (key === 'in' && args[0] === column) return refused();
              const out = (value as (...a: unknown[]) => unknown).call(b, ...args);
              return out === b ? r : out;
            };
          },
        });
      };
    },
  }) as unknown as DB;
}

const contribution = (familyId: string) => db.table('network_contributions').find((r) => r.family_id === familyId);
const metricsOf = (familyId: string) => contribution(familyId)?.metrics as Record<string, string> | undefined;
const publishedCounts = () => new Map(db.table('network_aggregates').map((r) => [`${r.cohort_key}|${r.metric}|${r.value}`, r.count as number]));

beforeEach(() => {
  db = createInMemorySupabase({ uniques: { network_contributions: [['family_id']], network_aggregates: [['scope', 'cohort_key', 'metric', 'value']] } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a consent that shares nothing contributes nothing (N14, N17)', () => {
  it('30 benchmark families and 70 with every scope off do not open the 100-family gate', async () => {
    for (let i = 0; i < 30; i++) household(`share-${i}`);
    for (let i = 0; i < 70; i++) household(`private-${i}`, { scopes: {} });
    const { db: client, namedFamilies } = recording(db);

    const result = await runNetworkAggregation(client, NOW);
    expect(result).toMatchObject({ ok: true, contributors: 30, aggregates: 0 });
    expect(db.table('network_aggregates')).toEqual([]);
    // Not stored, and not even read: the household of a private family is left alone.
    expect(db.table('network_contributions').map((r) => r.family_id).sort()).toEqual(Array.from({ length: 30 }, (_, i) => `share-${i}`).sort());
    for (let i = 0; i < 70; i++) expect(namedFamilies.has(`private-${i}`), `private-${i} was read`).toBe(false);
    expect(namedFamilies.has('share-0')).toBe(true);
  });

  it('a timing-only consent is private too, and the row it left on an earlier night is pruned', async () => {
    household('timing', { scopes: { timing: true, recommendations: true } });
    db.seed('network_contributions', [{ family_id: 'timing', cohort_key: 'kids:6–9|size:1–2', features: {}, metrics: {}, scopes: { timing: true } }]);
    expect((await runNetworkAggregation(db as unknown as DB, NOW)).ok).toBe(true);
    expect(contribution('timing')).toBeUndefined();
  });

  it('stores the cohort\'s two dimensions as features, and every band only under the metric it was consented for', async () => {
    household('fam');
    await runNetworkAggregation(db as unknown as DB, NOW);
    const row = contribution('fam')!;
    expect(row.features).toEqual({ childBands: ['6–9'], sizeBand: '1–2' });
    expect(Object.keys(row.metrics as object).sort()).toEqual(['activities', 'chores_per_child', 'dinner_habit', 'reminders_per_week']);
  });
});

describe('a consent written by a member who may not give it is not honoured (N7)', () => {
  beforeEach(() => {
    household('by-teen', { consentedBy: 'teen-user' });
    db.seed('family_members', [{ id: 'by-teen-t', family_id: 'by-teen', user_id: 'teen-user', role: 'teen', birthday: '2011-06-01', is_active: true }]);
    household('by-parent', { consentedBy: 'by-parent-parent' });
    household('by-nobody', { consentedBy: null });
    household('by-a-leaver', { consentedBy: 'gone-user' });
    db.seed('family_members', [{ id: 'gone-m', family_id: 'by-a-leaver', user_id: 'gone-user', role: 'child', birthday: null, is_active: false }]);
    // The teen's consent fed the network on an earlier night.
    db.seed('network_contributions', [{ family_id: 'by-teen', cohort_key: 'kids:6–9.14–17|size:3–4', features: {}, metrics: { dinner_habit: 'often (4–5)' }, scopes: { benchmarks: true } }]);
  });

  it('drops the household a teen opted in, and keeps the ones a manager (or no judgeable author) did', async () => {
    const result = await runNetworkAggregation(db as unknown as DB, NOW);
    expect(result).toMatchObject({ ok: true, contributors: 3 });
    expect(contribution('by-teen')).toBeUndefined();
    expect(contribution('by-parent')).toBeDefined();
    expect(contribution('by-nobody')).toBeDefined();
    expect(contribution('by-a-leaver')).toBeDefined();
  });

  it('when who consented cannot be read, it still forgets the withdrawn — and reports the failure', async () => {
    db.seed('network_contributions', [{ family_id: 'withdrew', cohort_key: 'x', features: {}, metrics: {}, scopes: {} }]);
    const result = await runNetworkAggregation(refusing(db, 'family_members', 'user_id'), NOW);
    expect(result).toMatchObject({ ok: false, error: 'failed to read who consented' });
    expect(contribution('withdrew')).toBeUndefined();
  });
});

describe('the withdrawn are forgotten first, whatever fails after (N8)', () => {
  it('prunes a withdrawn family\'s row even when a household source read fails', async () => {
    household('stays');
    db.seed('network_contributions', [{ family_id: 'withdrew', cohort_key: 'kids:none|size:1–2', features: {}, metrics: { dinner_habit: 'rarely (0–1)' }, scopes: { benchmarks: true } }]);
    const result = await runNetworkAggregation(refusing(db, 'transactions'), NOW);
    expect(result).toMatchObject({ ok: false, error: 'failed to read family data' });
    expect(contribution('withdrew')).toBeUndefined();
  });
});

describe('the noise is sticky: a night that changed nothing publishes the same figures (N11, N12)', () => {
  // Every night below is in September 2026, one publication epoch, except
  // where a test steps into October on purpose.
  const OCTOBER = new Date('2026-10-01T12:00:00Z');
  beforeEach(() => {
    for (let i = 0; i < 120; i++) household(`f-${i}`);
    // A "random" source that never repeats, for any code that still reaches for it.
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => 0.05 + 0.9 * ((i++ * 0.618033) % 1));
  });

  it('republishes every count unchanged on unchanged data — a night inside the epoch adds no sample', async () => {
    expect((await runNetworkAggregation(db as unknown as DB, NOW)).ok).toBe(true);
    const first = publishedCounts();
    expect(first.size).toBeGreaterThan(0);
    // non-vacuity: the counts ARE noised, not the true 120
    expect([...first.values()].some((count) => count !== 120)).toBe(true);
    for (let night = 1; night <= 3; night++) {
      expect((await runNetworkAggregation(db as unknown as DB, new Date(NOW.getTime() + night * 86_400_000))).ok).toBe(true);
      expect(publishedCounts()).toEqual(first);
    }
  });

  it('a band that changes and changes back publishes its earlier figure again', async () => {
    await runNetworkAggregation(db as unknown as DB, NOW);
    const before = publishedCounts();
    household('joiner');
    await runNetworkAggregation(db as unknown as DB, new Date(NOW.getTime() + 86_400_000));
    db.replace('network_consent', db.table('network_consent').filter((r) => r.family_id !== 'joiner'));
    await runNetworkAggregation(db as unknown as DB, new Date(NOW.getTime() + 2 * 86_400_000));
    expect(publishedCounts()).toEqual(before);
  });

  it('is keyed: the same cell and true count draw the same, another key or count draws anew', () => {
    const bandVector = JSON.stringify([['often (4–5)', 120], ['rarely (0–1)', 40]]);
    const cell = { scope: 'benchmarks' as const, cohortKey: 'kids:6–9|size:1–2', metric: 'dinner_habit', value: 'often (4–5)', cohortSize: 120, bandVector };
    const draw = stickyNoise('key-a', '2026-09');
    expect(draw(1.5, cell)).toBe(draw(1.5, { ...cell }));
    expect(draw(1.5, { ...cell, cohortSize: 121 })).not.toBe(draw(1.5, cell));
    expect(stickyNoise('key-b', '2026-09')(1.5, cell)).not.toBe(draw(1.5, cell));
    // and keyed on the epoch: the next one draws the same cell afresh
    expect(stickyNoise('key-a', '2026-10')(1.5, cell)).not.toBe(draw(1.5, cell));
    expect(Number.isFinite(draw(1.5, cell))).toBe(true);
    // and keyed on the whole metric: ANOTHER band's count moving redraws this one
    expect(draw(1.5, { ...cell, bandVector: JSON.stringify([['often (4–5)', 120], ['rarely (0–1)', 39]]) })).not.toBe(draw(1.5, cell));
  });

  // The re-fix of N1/N6 (sticky-diff): keyed on each cell's own count, one
  // household leaving moved only the figures of the bands it was in, so two
  // nights compared named them. The other bands of its metrics must move too.
  // Inside the epoch nothing moves at all (the snapshot is held); the leaver
  // reaches the figures at the next epoch, where the other bands redraw.
  it('one family leaving redraws the other bands of its metrics, so the diff cannot say which band it was in', async () => {
    // 25 more households in the same cohort plan four dinners ("often") in
    // both months, so dinner has a band the leaver (an f-* household,
    // "rarely") is not in; 25 childless ones form a cohort the leaver is not
    // in at all.
    for (let i = 0; i < 25; i++) {
      household(`often-${i}`);
      db.seed('meal_plans', [NOW, OCTOBER].flatMap((from) => [1, 2, 3, 4].map((d) => ({ family_id: `often-${i}`, meal_type: 'dinner', plan_date: dayKey(d, from) }))));
    }
    for (let i = 0; i < 25; i++) household(`nokid-${i}`, { kid: false });
    const consents = db.table('network_consent').map((r) => ({ ...r }));
    const often = 'kids:6–9|size:1–2|dinner_habit|often (4–5)';
    const otherCohort = (counts: Map<string, number>) => [...counts].filter(([cell]) => cell.startsWith('kids:none|'));
    let oftenMoved = 0;
    const keys = Array.from({ length: 12 }, (_, i) => `deployment-secret-${i}`);
    try {
      for (const key of keys) {
        vi.stubEnv('INTERNAL_SECRET', key);
        db.replace('network_aggregates', []);
        db.replace('network_consent', consents.map((r) => ({ ...r })));
        expect((await runNetworkAggregation(db as unknown as DB, NOW)).ok).toBe(true);
        const before = publishedCounts();
        expect(before.has(often)).toBe(true);
        expect(before.has('kids:6–9|size:1–2|dinner_habit|rarely (0–1)')).toBe(true);
        expect(otherCohort(before).length).toBeGreaterThanOrEqual(3);
        // f-0 leaves the network.
        db.replace('network_consent', consents.filter((r) => r.family_id !== 'f-0').map((r) => ({ ...r })));
        expect((await runNetworkAggregation(db as unknown as DB, new Date(NOW.getTime() + 86_400_000))).ok).toBe(true);
        const after = publishedCounts();
        expect(contribution('f-0')).toBeUndefined();
        // a cohort the leaver was not in republishes its figures exactly …
        expect(otherCohort(after)).toEqual(otherCohort(before));
        // … as does every other figure inside the epoch: the snapshot is held …
        expect(after).toEqual(before);
        // … and at the next epoch a band of its metric it was not in redraws
        // (rounded, a redraw lands on the same whole number about one time in six)
        expect((await runNetworkAggregation(db as unknown as DB, OCTOBER)).ok).toBe(true);
        const next = publishedCounts();
        expect(next.has(often)).toBe(true);
        if (next.get(often) !== before.get(often)) oftenMoved++;
      }
    } finally {
      vi.unstubAllEnvs();
    }
    // Keyed per cell, "often" never moved: its true count did not change.
    expect(oftenMoved).toBeGreaterThanOrEqual(keys.length / 2);
  });
});

describe('the write order knows nothing of the true sizes (N1, write order)', () => {
  // The cron upserted biggest band first, and a read with no order clause —
  // any consenting member's, through RLS — returns rows much as they were last
  // written: the table itself ranked the bands by their TRUE size.
  it('upserts the aggregates by cohort, metric and band, never biggest first', async () => {
    for (let i = 0; i < 25; i++) household(`kid-${i}`);
    for (let i = 0; i < 120; i++) household(`nokid-${i}`, { kid: false });
    expect((await runNetworkAggregation(db as unknown as DB, NOW)).ok).toBe(true);
    const written = db.table('network_aggregates').map((r) => ({ cohort: r.cohort_key as string, metric: r.metric as string, value: r.value as string, size: r.cohort_size as number }));
    // non-vacuity: two sizes, and the small cohort sorts first by key
    expect(new Set(written.map((r) => r.size))).toEqual(new Set([25, 120]));
    const byKey = (a: typeof written[number], b: typeof written[number]) => {
      const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
      return cmp(a.cohort, b.cohort) || cmp(a.metric, b.metric) || cmp(a.value, b.value);
    };
    expect(written).toEqual([...written].sort(byKey));
    expect(written.map((r) => r.size)).not.toEqual([...written].map((r) => r.size).sort((a, b) => b - a));
    expect(written[0]).toMatchObject({ cohort: 'kids:6–9|size:1–2', size: 25 });
  });
});

describe('the contribution is the household\'s own week, on its own calendar (N13, N15)', () => {
  it('counts the Reminders module\'s open reminders this week', async () => {
    household('fam');
    db.seed('family_reminders', [
      ...[1, 2, 3, 4, 5].map((d) => ({ family_id: 'fam', status: 'active', remind_at: iso(d), snoozed_until: null })),
      { family_id: 'fam', status: 'completed', remind_at: iso(2), snoozed_until: null },
    ]);
    await runNetworkAggregation(db as unknown as DB, NOW);
    expect(metricsOf('fam')?.reminders_per_week).toBe('4–7');
  });

  it('a Monday-to-Friday dinner planner plans "often", not "most nights"', async () => {
    household('weekdays');
    // Tue, Wed, Thu, Fri, Mon, and next Tuesday — the eighth day.
    db.seed('meal_plans', [0, 1, 2, 3, 6, 7].map((d) => ({ family_id: 'weekdays', meal_type: 'dinner', plan_date: dayKey(d) })));
    await runNetworkAggregation(db as unknown as DB, NOW);
    expect(metricsOf('weekdays')?.dinner_habit).toBe('often (4–5)');
  });

  it('98 a week is "under 100": four weeks of spending, not four weeks and a day', async () => {
    household('spender');
    db.seed('transactions', Array.from({ length: 29 }, (_, i) => ({ family_id: 'spender', amount: 14, type: 'expense', date: dayKey(-i) })));
    await runNetworkAggregation(db as unknown as DB, NOW);
    expect(metricsOf('spender')?.weekly_spend_band).toBe('under 100');
  });

  it('reads a Pacific family\'s dinners on its own day, not Greenwich\'s', async () => {
    const evening = new Date('2026-09-08T03:00:00Z'); // 20:00 on Monday 7 September in Los Angeles
    household('pacific', { tz: 'America/Los_Angeles' });
    db.seed('meal_plans', ['2026-09-07', '2026-09-08'].map((plan_date) => ({ family_id: 'pacific', meal_type: 'dinner', plan_date })));
    await runNetworkAggregation(db as unknown as DB, evening);
    expect(metricsOf('pacific')?.dinner_habit).toBe('sometimes (2–3)');
  });
});
