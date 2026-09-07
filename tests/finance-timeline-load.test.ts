import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadMoneyTimeline, loadMoneyTimelineInput, planCommitments } from '@/lib/finance/timeline-load';

// A chainable query stub: every builder method returns the chain and the chain
// is thenable, resolving to the supplied PostgREST-shaped `{ data, error }`.
// Mirrors the loader's calls (`from(t).select().eq().in().gte().lte().order().limit()`).
type Reply = { data: unknown; error: unknown };
function chain(result: Reply) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'limit']) c[m] = () => c;
  c.then = (res: (v: Reply) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return c;
}

function fakeSupabase(results: Record<string, Reply>, seen: string[] = []): SupabaseClient<Database> {
  return {
    from: (table: string) => { seen.push(table); return chain(results[table] ?? { data: [], error: null }); },
  } as unknown as SupabaseClient<Database>;
}

const NOW = new Date('2026-01-05T00:00:00Z'); // a Monday

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
    }, NOW);

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
    await expect(loadMoneyTimelineInput(supabase, 'fam-1', NOW)).rejects.toEqual(readError);
    expect(err).toHaveBeenCalledWith('[finance/timeline] money timeline read failed', { table: 'subscriptions_tracked', error: readError });
  });

  it('tolerates a genuinely missing plan table as "no commitments from that module"', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase({
      financial_accounts: { data: [{ balance: 4000, type: 'checking' }, { balance: -900, type: 'credit' }], error: null },
      moves: { data: null, error: { code: '42P01', message: 'relation "public.moves" does not exist' } },
      home_projects: { data: [{ title: 'Kitchen tap', status: 'scheduled', budget_cents: 30000, target_start: '2026-01-20', target_end: null }], error: null },
    });

    const input = await loadMoneyTimelineInput(supabase, 'fam-1', NOW);
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

    const timeline = await loadMoneyTimeline(supabase, 'fam-1', NOW);
    expect(seen).toEqual(expect.arrayContaining([
      'bills', 'savings_goals', 'financial_accounts', 'calendar_events',
      'subscriptions_tracked', 'vacations', 'vacation_budgets', 'vacation_expenses', 'moves', 'home_projects',
    ]));
    expect(timeline.coverage.coveredCount).toBe(3);
    expect(timeline.planOutflow).toBe(1000);
    // Rent (Feb 10) shares the week of Feb 9 with the trip (Feb 14); the trip is the plan moment.
    const trip = timeline.weeks.find((w) => w.weekStart === '2026-02-09')!.moments.find((m) => m.kind === 'plan');
    expect(trip).toMatchObject({ label: 'Spring break', kind: 'plan', source: 'vacation', amount: 1000, date: '2026-02-14' });
    expect(timeline.lowestBalance).toBe(5000 - 3000 - 1000);
  });

  it('passes a scenario through to the brain without re-reading', async () => {
    const seen: string[] = [];
    const supabase = fakeSupabase({ financial_accounts: { data: [{ balance: 1000, type: null }], error: null } }, seen);
    const timeline = await loadMoneyTimeline(supabase, 'fam-1', NOW, { scenario: { label: 'Laptop', amount: 900, date: '2026-01-21' } });
    expect(timeline.scenarioOutflow).toBe(900);
    expect(timeline.lowestBalance).toBe(100);
    expect(seen.filter((t) => t === 'bills')).toHaveLength(1);
  });
});
