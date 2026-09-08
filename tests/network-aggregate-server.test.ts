// The cron path, end to end: CONTRIBUTE (raw household rows → one banded
// contribution per consenting family) then AGGREGATE (k-anonymity + launch
// gate → network_aggregates), against the in-memory Supabase. What the audit
// found missing was exactly this: the pure cores were tested, the server path
// that wires them to real tables was not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { runNetworkAggregation, OPEN_CHORE_STATUSES } from '@/lib/network/aggregate-server';
import { AGG_DEFAULTS, BENCHMARK_METRICS } from '@/lib/network/aggregate';
import { K_ANONYMITY_FLOOR } from '@/lib/network/insights';

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-09-07T08:00:00Z');
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const iso = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString();

let db: ReturnType<typeof createInMemorySupabase<DB>>;

/**
 * One consenting household with two kids, a parent, three open kid chores, a
 * 20:30 bedtime routine, 400 of expenses over the trailing four weeks and two
 * reminders this coming week. Every raw number here must be banded away.
 */
function seedFamily(id: string, opts: { scopes?: Record<string, boolean>; enabled?: boolean; spend?: number; bedtime?: string } = {}) {
  const parent = `${id}-p`; const kidA = `${id}-a`; const kidB = `${id}-b`;
  db.seed('network_consent', [{ family_id: id, enabled: opts.enabled ?? true, scopes: opts.scopes ?? { benchmarks: true } }]);
  db.seed('family_members', [
    { id: parent, family_id: id, role: 'parent', birthday: '1985-03-03', is_active: true },
    { id: kidA, family_id: id, role: 'child', birthday: '2018-06-01', is_active: true },
    { id: kidB, family_id: id, role: 'teen', birthday: '2011-06-01', is_active: true },
    { id: `${id}-gone`, family_id: id, role: 'child', birthday: '2016-01-01', is_active: false },
  ]);
  db.seed('meal_plans', [
    { family_id: id, meal_type: 'dinner', plan_date: day(1) },
    { family_id: id, meal_type: 'dinner', plan_date: day(2) },
    { family_id: id, meal_type: 'dinner', plan_date: day(3) },
    { family_id: id, meal_type: 'dinner', plan_date: day(3) },     // same night twice → one dinner
    { family_id: id, meal_type: 'lunch', plan_date: day(4) },      // not a dinner
    { family_id: id, meal_type: 'dinner', plan_date: day(20) },    // outside the week
  ]);
  db.seed('teams', [{ family_id: id, is_active: true }]);
  db.seed('school_classes', [{ family_id: id }]);
  db.seed('chore_assignments', [
    { family_id: id, member_id: kidA, status: 'todo' },
    { family_id: id, member_id: kidA, status: 'in_progress' },
    { family_id: id, member_id: kidB, status: 'submitted' },
    { family_id: id, member_id: kidB, status: 'approved' },        // closed → not open
    { family_id: id, member_id: parent, status: 'todo' },          // an adult's chore → not "per child"
  ]);
  db.seed('bedtime_routines', [
    { family_id: id, member_id: kidA, target_bedtime: opts.bedtime ?? '20:30:00', is_active: true },
    { family_id: id, member_id: kidB, target_bedtime: '23:45:00', is_active: false },  // inactive
    { family_id: id, member_id: parent, target_bedtime: '23:30:00', is_active: true }, // an adult
  ]);
  const spend = opts.spend ?? 400;
  db.seed('transactions', [
    { family_id: id, amount: spend / 2, type: 'expense', date: day(-3) },
    { family_id: id, amount: spend / 2, type: 'expense', date: day(-20) },
    { family_id: id, amount: 9999, type: 'income', date: day(-1) },      // not an expense
    { family_id: id, amount: 9999, type: 'expense', date: day(-40) },    // outside the window
  ]);
  db.seed('reminders', [
    { family_id: id, remind_at: iso(1) },
    { family_id: id, remind_at: iso(6) },
    { family_id: id, remind_at: iso(12) },   // outside the week
    { family_id: id, remind_at: iso(-1) },   // already past
  ]);
}

beforeEach(() => {
  db = createInMemorySupabase<DB>({ uniques: { network_contributions: [['family_id']], network_aggregates: [['scope', 'cohort_key', 'metric', 'value']] } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('CONTRIBUTE — one banded row per consenting family', () => {
  it('writes only bands, drawn from the household’s own rows, under the benchmarks scope', async () => {
    seedFamily('fam-1');
    const result = await runNetworkAggregation(db, NOW);
    expect(result.ok).toBe(true);
    expect(result.contributors).toBe(1);

    const rows = db.table('network_contributions');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.family_id).toBe('fam-1');
    expect(row.cohort_key).toBe('kids:6–9.14–17|size:3–4'); // 8 and 15 years old, 3 active members
    expect(row.metrics).toEqual({
      dinner_habit: 'sometimes (2–3)',   // 3 distinct dinner nights
      activities: '1–2',                 // 1 team + 1 class
      reminders_per_week: '1–3',         // 2 reminders in the coming week
      chores_per_child: '1–2',           // 3 open kid chores / 2 kids → 2 (rounded)
      bedtime_band: '8–9pm',             // the one active KID routine at 20:30
      weekly_spend_band: '100–250',      // 400 over 4 weeks → 100/week
    });
    // no raw value anywhere in what left the household
    const flat = JSON.stringify({ features: row.features, metrics: row.metrics });
    for (const raw of ['2018', '2011', '1985', '20:30', '23:30', '400', '200', 'fam-1-a']) expect(flat).not.toContain(raw);
  });

  it('omits the inapplicable metrics for a household without children or tracked spend', async () => {
    db.seed('network_consent', [{ family_id: 'solo', enabled: true, scopes: { benchmarks: true } }]);
    db.seed('family_members', [{ id: 'solo-p', family_id: 'solo', role: 'adult', birthday: null, is_active: true }]);
    const result = await runNetworkAggregation(db, NOW);
    expect(result.ok).toBe(true);
    const row = db.table('network_contributions')[0]!;
    expect(row.cohort_key).toBe('kids:none|size:1–2');
    expect(Object.keys(row.metrics as Record<string, string>).sort()).toEqual(['activities', 'dinner_habit', 'reminders_per_week']);
  });

  it('honours granular consent at write time: a timing-only family contributes no benchmark metric', async () => {
    seedFamily('timing-only', { scopes: { timing: true } });
    await runNetworkAggregation(db, NOW);
    expect(db.table('network_contributions')[0]!.metrics).toEqual({});
  });

  it('prunes the row of a family that opted out and skips a disabled consent', async () => {
    seedFamily('stays');
    seedFamily('leaves', { enabled: false });
    db.seed('network_contributions', [{ family_id: 'leaves', cohort_key: 'kids:none|size:1–2', metrics: { dinner_habit: 'rarely (0–1)' }, features: {}, scopes: {} }]);
    const result = await runNetworkAggregation(db, NOW);
    expect(result.ok).toBe(true);
    expect(db.table('network_contributions').map((r) => r.family_id)).toEqual(['stays']);
  });

  it('fails closed when a household source cannot be read — nothing is written, the cron reports failure', async () => {
    seedFamily('fam-1');
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          if (table !== 'transactions') return target.from(table);
          const builder: Record<string, unknown> = {};
          const chain = () => builder;
          for (const m of ['select', 'in', 'eq', 'gte', 'lte']) builder[m] = chain;
          builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'connection reset' } });
          return builder;
        };
      },
    }) as unknown as DB;
    const result = await runNetworkAggregation(failing, NOW);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('failed to read family data');
    expect(db.table('network_contributions')).toHaveLength(0);
    expect(db.table('network_aggregates')).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith('[network] family contribution source read failed', expect.objectContaining({ message: 'connection reset' }));
  });
});

describe('AGGREGATE — the launch gate and the k-floor, on real tables', () => {
  it('publishes nothing below the launch gate, whatever the cohorts look like', async () => {
    for (let i = 0; i < AGG_DEFAULTS.globalMinFamilies - 1; i++) seedFamily(`f-${i}`);
    const result = await runNetworkAggregation(db, NOW);
    expect(result.ok).toBe(true);
    expect(result.contributors).toBe(AGG_DEFAULTS.globalMinFamilies - 1);
    expect(result.aggregates).toBe(0);
    expect(db.table('network_aggregates')).toHaveLength(0);
  });

  it('past the gate, publishes each of the six metrics only where ≥ K distinct families share a band', async () => {
    // 110 families share every band; 10 spend far more → their spend band is suppressed,
    // and the rest of their metrics still count toward the shared bands.
    for (let i = 0; i < 110; i++) seedFamily(`f-${i}`);
    for (let i = 0; i < 10; i++) seedFamily(`rich-${i}`, { spend: 8000 });
    const result = await runNetworkAggregation(db, NOW);
    expect(result.ok).toBe(true);
    expect(result.contributors).toBe(120);

    const rows = db.table('network_aggregates');
    expect(rows.length).toBe(result.aggregates);
    for (const r of rows) {
      expect(r.scope).toBe('benchmarks');
      expect(r.cohort_key).toBe('kids:6–9.14–17|size:3–4');
      expect(r.cohort_size as number).toBeGreaterThanOrEqual(K_ANONYMITY_FLOOR);
      expect(r.computed_at).toBe(NOW.toISOString());
      expect(BENCHMARK_METRICS.map((m) => m.key)).toContain(r.metric);
    }
    const byMetric = new Map(rows.map((r) => [r.metric, r]));
    expect(byMetric.get('weekly_spend_band')).toMatchObject({ value: '100–250', cohort_size: 110 });
    expect(rows.some((r) => r.metric === 'weekly_spend_band' && r.value === '1,000+')).toBe(false); // 10 < K
    for (const metric of ['chores_per_child', 'bedtime_band', 'reminders_per_week', 'dinner_habit', 'activities']) {
      expect(byMetric.get(metric)?.cohort_size, metric).toBe(120);
    }
  });

  it('republishes on the natural key and prunes rows the run did not touch', async () => {
    for (let i = 0; i < 120; i++) seedFamily(`f-${i}`);
    db.seed('network_aggregates', [{ scope: 'benchmarks', cohort_key: 'kids:none|size:1–2', metric: 'dinner_habit', value: 'rarely (0–1)', count: 30, cohort_size: 30, computed_at: iso(-1) }]);
    const first = await runNetworkAggregation(db, NOW);
    expect(first.ok).toBe(true);
    expect(db.table('network_aggregates').some((r) => r.cohort_key === 'kids:none|size:1–2')).toBe(false);
    const countAfterFirst = db.table('network_aggregates').length;

    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await runNetworkAggregation(db, later);
    expect(second.ok).toBe(true);
    expect(db.table('network_aggregates')).toHaveLength(countAfterFirst); // upsert, not duplicate
    expect(db.table('network_aggregates').every((r) => r.computed_at === later.toISOString())).toBe(true);
  });

  it('only OPEN assignments feed chores per child', () => {
    expect([...OPEN_CHORE_STATUSES]).toEqual(['todo', 'in_progress', 'submitted']);
  });
});
