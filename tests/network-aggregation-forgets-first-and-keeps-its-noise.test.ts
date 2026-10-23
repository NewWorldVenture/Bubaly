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
//   true counts.
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
  beforeEach(() => {
    for (let i = 0; i < 120; i++) household(`f-${i}`);
    // A "random" source that never repeats, for any code that still reaches for it.
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => 0.05 + 0.9 * ((i++ * 0.618033) % 1));
  });

  it('republishes every count unchanged on unchanged data — averaging nights recovers nothing', async () => {
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
    const cell = { scope: 'benchmarks' as const, cohortKey: 'kids:6–9|size:1–2', metric: 'dinner_habit', value: 'often (4–5)', cohortSize: 120 };
    const draw = stickyNoise('key-a');
    expect(draw(1.5, cell)).toBe(draw(1.5, { ...cell }));
    expect(draw(1.5, { ...cell, cohortSize: 121 })).not.toBe(draw(1.5, cell));
    expect(stickyNoise('key-b')(1.5, cell)).not.toBe(draw(1.5, cell));
    expect(Number.isFinite(draw(1.5, cell))).toBe(true);
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
