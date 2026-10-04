import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadMoneyTimeline, loadMoneyTimelineInput, planCommitments } from '@/lib/finance/timeline-load';

// A chainable query stub: every builder method returns the chain and the chain
// is thenable, resolving to the supplied PostgREST-shaped `{ data, error }`.
// Mirrors the loader's calls (`from(t).select().eq().in().gte().lte().lt().order().limit()`).
type Reply = { data: unknown; error: unknown };
/** A table's answer: one reply for every call, or one per call in order (the pre-0488 retry asks `bills` twice). */
type Answer = Reply | ((call: number) => Reply);
function chain(result: Reply, onSelect?: (columns: string) => void) {
  const c: Record<string, unknown> = {};
  for (const m of ['eq', 'neq', 'in', 'gte', 'gt', 'lte', 'lt', 'order', 'limit']) c[m] = () => c;
  c.select = (columns: string) => { onSelect?.(columns); return c; };
  // `.range()` slices, so a paged read reaches an empty page and stops. Without
  // that a stub returning all rows to every call would page to its ceiling.
  c.range = (from: number, to: number) => ({
    then: (res: (v: Reply) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(
      Array.isArray(result.data) ? { ...result, data: result.data.slice(from, to + 1) } : result,
    ).then(res, rej),
  });
  c.then = (res: (v: Reply) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return c;
}

function fakeSupabase(results: Record<string, Answer>, seen: string[] = [], selects: Record<string, string[]> = {}): SupabaseClient<Database> {
  const calls: Record<string, number> = {};
  return {
    from: (table: string) => {
      seen.push(table);
      const n = (calls[table] = (calls[table] ?? 0) + 1);
      const answer = results[table];
      const reply = typeof answer === 'function' ? answer(n) : answer ?? { data: [], error: null };
      return chain(reply, (columns) => { (selects[table] ??= []).push(columns); });
    },
  } as unknown as SupabaseClient<Database>;
}

const NOW = new Date('2026-01-05T00:00:00Z'); // a Monday
// The zone is named on every call, because the loader now resolves its day keys
// in the FAMILY's zone and "unbound" is not a zone. These cases pin it to 'UTC',
// where the instant above is already 2026-01-05, so the literals below are about
// the mapping rather than about the calendar. What the mapping does in a zone
// that disagrees with Greenwich is
// tests/the-money-forecast-is-the-familys-week.test.ts.
const TZ = 'UTC';

describe('planCommitments (row → forecast mapping)', () => {
  it('maps cents to dollars and places each plan on the date its money is needed', () => {
    const plans = planCommitments({
      subscriptions: [
        { name: 'Streaming', cost_cents: 1599, cadence: 'monthly', status: 'active', next_charge: '2026-01-15', category: 'entertainment' },
        { name: 'Cloud backup', cost_cents: 12000, cadence: 'yearly', status: 'trial', next_charge: null, category: null },
        { name: 'Old gym', cost_cents: 4000, cadence: 'monthly', status: 'canceled', next_charge: '2026-01-10', category: null },
      ],
      vacations: [
        { id: 'v1', title: 'Spring break', start_date: '2026-02-14', status: 'booked', budget_cents: 500000 },
        { id: 'v2', title: 'No budget lines', start_date: '2026-03-01', status: 'planning', budget_cents: 80000 },
        { id: 'v3', title: 'Already gone', start_date: '2025-12-20', status: 'booked', budget_cents: 100000 },
        { id: 'v4', title: 'Cancelled', start_date: '2026-02-01', status: 'cancelled', budget_cents: 100000 },
      ],
      vacationBudgets: [
        { vacation_id: 'v1', planned_cents: 200000 },
        { vacation_id: 'v1', planned_cents: 100000 },
      ],
      vacationExpenses: [
        { vacation_id: 'v1', amount_cents: 50000 },
        { vacation_id: 'v2', amount_cents: 90000 },
      ],
      moves: [
        { title: 'Move to Elm St', move_date: '2026-03-02', status: 'packing', budget_cents: 300000, spent_cents: 120000 },
        { title: 'Done move', move_date: '2026-01-20', status: 'done', budget_cents: 300000, spent_cents: 0 },
      ],
      projects: [
        { title: 'Kitchen tap', status: 'scheduled', budget_cents: 30000, target_start: '2026-01-20', target_end: null },
        { title: 'Fence', status: 'in_progress', budget_cents: 45000, target_start: null, target_end: null },
        { title: 'Someday deck', status: 'idea', budget_cents: 900000, target_start: null, target_end: null },
        { title: 'Undated plan', status: 'planning', budget_cents: 10000, target_start: null, target_end: null },
      ],
    }, TZ, NOW);

    expect(plans).toEqual([
      // Real cost on the real cadence from next_charge; a canceled one is not live.
      { label: 'Streaming', amount: 15.99, date: '2026-01-15', source: 'subscription', recurrence: 'monthly', category: 'entertainment' },
      // No next charge: the monthly equivalent ($120/yr → $10/mo) accrues from the 1st of next month.
      { label: 'Cloud backup', amount: 10, date: '2026-02-01', source: 'subscription', recurrence: 'monthly', category: 'subscriptions' },
      // Budget lines (2000 + 1000) minus spent (500) = 2500, needed by departure. The trip's own
      // budget_cents is only the fallback when there are no lines.
      { label: 'Spring break', amount: 2500, date: '2026-02-14', source: 'vacation', category: 'travel' },
      // No lines → budget_cents 800 minus spent 900 → nothing left → skipped; past/cancelled trips skipped.
      { label: 'Move to Elm St', amount: 1800, date: '2026-03-02', source: 'move', category: 'moving' },
      { label: 'Kitchen tap', amount: 300, date: '2026-01-20', source: 'project', category: 'home' },
      // In progress with no date is spending now; an idea or an undated plan is not a commitment yet.
      { label: 'Fence', amount: 450, date: '2026-01-05', source: 'project', category: 'home' },
    ]);
  });
});

describe('loadMoneyTimelineInput read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fails closed (throws) on a real read error and logs which table failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readError = { code: '42501', message: 'permission denied for table subscriptions_tracked' };
    const supabase = fakeSupabase({
      bills: { data: [{ name: 'Rent', amount: 1000, due_date: '2026-01-10', is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: true }], error: null },
      subscriptions_tracked: { data: null, error: readError },
    });

    // Design: a forecast missing a table's commitments is a reassuring-but-wrong
    // balance, so the loader never degrades to "no commitments" on a real error.
    await expect(loadMoneyTimelineInput(supabase, 'fam-1', TZ, NOW)).rejects.toEqual(readError);
    expect(err).toHaveBeenCalledWith('[finance/timeline] money timeline read failed', { table: 'subscriptions_tracked', error: readError });
  });

  it('tolerates a genuinely missing plan table as "no commitments from that module"', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase({
      financial_accounts: { data: [{ balance: 4000, type: 'checking' }, { balance: -900, type: 'credit' }], error: null },
      moves: { data: null, error: { code: '42P01', message: 'relation "public.moves" does not exist' } },
      home_projects: { data: [{ title: 'Kitchen tap', status: 'scheduled', budget_cents: 30000, target_start: '2026-01-20', target_end: null }], error: null },
    });

    const input = await loadMoneyTimelineInput(supabase, 'fam-1', TZ, NOW);
    expect(input.startingBalance).toBe(4000);
    expect(input.plans).toEqual([{ label: 'Kitchen tap', amount: 300, date: '2026-01-20', source: 'project', category: 'home' }]);
    expect(err).not.toHaveBeenCalled();
  });

  it('reads every plan table and hands bills (with autopay) and plans to the brain', async () => {
    const seen: string[] = [];
    const supabase = fakeSupabase({
      bills: { data: [{ name: 'Rent', amount: 1000, due_date: '2026-01-10', is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: true }], error: null },
      financial_accounts: { data: [{ balance: 5000, type: 'checking' }], error: null },
      vacations: { data: [{ id: 'v1', title: 'Spring break', start_date: '2026-02-14', status: 'booked', budget_cents: 120000 }], error: null },
      vacation_expenses: { data: [{ vacation_id: 'v1', amount_cents: 20000 }], error: null },
    }, seen);

    const timeline = await loadMoneyTimeline(supabase, 'fam-1', TZ, NOW);
    expect(seen).toEqual(expect.arrayContaining([
      'bills', 'savings_goals', 'financial_accounts', 'calendar_events',
      'subscriptions_tracked', 'vacations', 'vacation_budgets', 'vacation_expenses', 'moves', 'home_projects',
    ]));
    expect(timeline.coverage.coveredCount).toBe(3);  // three rent payments…
    expect(timeline.coverage.coveredBills).toBe(1);  // …from one covered bill
    expect(timeline.coverage.totalBills).toBe(1);
    expect(timeline.planOutflow).toBe(1000);
    // Rent (Feb 10) shares the week of Feb 9 with the trip (Feb 14); the trip is the plan moment.
    const trip = timeline.weeks.find((w) => w.weekStart === '2026-02-09')!.moments.find((m) => m.kind === 'plan');
    expect(trip).toMatchObject({ label: 'Spring break', kind: 'plan', source: 'vacation', amount: 1000, date: '2026-02-14' });
    expect(timeline.lowestBalance).toBe(5000 - 3000 - 1000);
  });

  // Review 5981518473 / 5981566086 on #932: the forecast steps a month-end bill
  // by `due_day` (0488), but this loader's projection omitted the column, so a
  // row already clamped to Feb 28 with its anchor 31 recorded forecast March 28
  // in production however right the pure builder was. The projection carries
  // the column; a database that has not applied 0488 refuses it and is asked
  // once more without it.
  it('reads each bill\'s anchor day, so a clamped month-end row forecasts the month end again', async () => {
    const selects: Record<string, string[]> = {};
    const supabase = fakeSupabase({
      bills: { data: [{ name: 'Rent', amount: 1000, due_date: '2026-02-28', due_day: 31, is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: false }], error: null },
    }, [], selects);
    const input = await loadMoneyTimelineInput(supabase, 'fam-1', TZ, new Date('2026-02-20T00:00:00Z'));
    expect(selects.bills).toEqual(['name, amount, due_date, due_day, is_recurring, recurrence, status, category, autopay']);
    expect(input.bills).toEqual([expect.objectContaining({ due_date: '2026-02-28', due_day: 31 })]);
    const timeline = await loadMoneyTimeline(supabase, 'fam-1', TZ, new Date('2026-02-20T00:00:00Z'));
    const rent = timeline.weeks.flatMap((w) => w.moments).filter((m) => m.label === 'Rent').map((m) => m.date);
    expect(rent).toContain('2026-03-31');
    expect(rent).not.toContain('2026-03-28');
  });

  it('a database without 0488 is asked once more without the column, and steps the bill from its due date\'s day', async () => {
    const selects: Record<string, string[]> = {};
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const supabase = fakeSupabase({
      bills: (call) => (call === 1
        ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache" } }
        : { data: [{ name: 'Rent', amount: 1000, due_date: '2026-02-28', is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: false }], error: null }),
    }, [], selects);
    const input = await loadMoneyTimelineInput(supabase, 'fam-1', TZ, new Date('2026-02-20T00:00:00Z'));
    expect(selects.bills).toEqual([
      'name, amount, due_date, due_day, is_recurring, recurrence, status, category, autopay',
      'name, amount, due_date, is_recurring, recurrence, status, category, autopay',
    ]);
    expect(input.bills).toEqual([expect.objectContaining({ due_date: '2026-02-28' })]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('0488_a_month_end_bill_keeps_its_day'));
    // Any other refusal is the loader's failure, as before.
    const refused = fakeSupabase({ bills: { data: null, error: { code: '42501', message: 'permission denied for table bills' } } });
    await expect(loadMoneyTimelineInput(refused, 'fam-1', TZ, new Date('2026-02-20T00:00:00Z'))).rejects.toMatchObject({ code: '42501' });
  });

  it('passes a scenario through to the brain without re-reading', async () => {
    const seen: string[] = [];
    const supabase = fakeSupabase({ financial_accounts: { data: [{ balance: 1000, type: null }], error: null } }, seen);
    const timeline = await loadMoneyTimeline(supabase, 'fam-1', TZ, NOW, { scenario: { label: 'Laptop', amount: 900, date: '2026-01-21' } });
    expect(timeline.scenarioOutflow).toBe(900);
    expect(timeline.lowestBalance).toBe(100);
    expect(seen.filter((t) => t === 'bills')).toHaveLength(1);
  });
});
