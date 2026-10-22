// A saved $0 limit is a budget, not an unlimited-spending sentinel. Exercise
// the real writer, registered tool/trust gate, service, summary and result card.
// The database transport is modeled; this does not prove PostgreSQL RLS.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, withFaults, type Row } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const server = vi.hoisted(() => ({ client: null as DB | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!server.client) throw new Error('No test ledger client');
    return server.client;
  },
}));

const { toToolSpecs } = await import('@/lib/ai/tools/legacy-adapter');
const { budgetVsActual, updateBudget } = await import('@/lib/services/finances');
const { cardFromToolResult } = await import('@/lib/ai/result-cards');

const FAMILY = 'family-zero-budget';
const NAME = 'finances.budgetVsActual';
const NOW = new Date('2026-10-16T12:00:00Z');
const PERIODS = ['weekly', 'monthly', 'yearly'] as const;
type Period = typeof PERIODS[number];
const WINDOWS = {
  weekly: { from: '2026-10-10', to: '2026-10-16' },
  monthly: { from: '2026-10-01', to: '2026-10-31' },
  yearly: { from: '2026-01-01', to: '2026-12-31' },
};

function expense(id: string, amount: number, category = 'Dining', date = '2026-10-16'): Row {
  return { id, family_id: FAMILY, name: category, category, amount, date, type: 'expense', status: 'posted' };
}

function household() {
  const db = createInMemorySupabase();
  const client = db as unknown as DB;
  server.client = client;
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  const scope: ServiceScope = {
    db: client, familyId: FAMILY, userId: 'auth-parent', memberId: 'member-parent',
    role: 'parent', actorKind: 'member', tz: 'UTC', now: NOW,
  };
  const from = vi.spyOn(db, 'from');
  const save = async (amount = 0, period: Period = 'monthly', category = 'Dining') => {
    const result = await updateBudget(scope, { category, amount, period });
    expect(result).toMatchObject({ ok: true, data: { budget: { family_id: FAMILY, category, period } } });
    return result;
  };
  const read = async (overrides: Partial<ServiceScope> = {}) => {
    const before = structuredClone({ budgets: db.table('budgets'), transactions: db.table('transactions') });
    const spec = toToolSpecs({ ...scope, actorKind: 'ai', ...overrides }, { names: [NAME] })[0];
    expect(spec.name).toBe('finances_budgetVsActual');
    const result = await spec.execute({ month: null });
    // The read and its trust checks must not rewrite the financial records.
    expect({ budgets: db.table('budgets'), transactions: db.table('transactions') }).toEqual(before);
    return result;
  };
  return { db, scope, from, save, read };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('This fixture may not use the network'); }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  server.client = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a zero-dollar budget remains an enforceable spending limit', () => {
  it.each(PERIODS)('reports one cent against a saved zero %s budget as over, including its card', async (period) => {
    const h = household();
    expect(await h.save(0, period)).toMatchObject({ ok: true, data: { budget: { amount: 0 }, created: true } });
    expect(h.db.table('budgets')).toEqual([expect.objectContaining({ amount: 0, period })]);
    h.db.seed('transactions', [expense('spent-cent', 0.01)]);
    const result = await h.read();
    expect(result).toMatchObject({
      ok: true, summary: expect.stringContaining('1 budget over for 2026-10'),
      data: {
        month: '2026-10', total_limit: 0, total_spent: 0.01, over_count: 1,
        budgets: [{ category: 'Dining', period, limit: 0, spent: 0.01, remaining: -0.01,
          pct: 999, over: true, window: WINDOWS[period], transaction_count: 1 }],
      },
    });
    expect(cardFromToolResult(NAME, {}, result)).toMatchObject({
      kind: 'budget_analysis', total_limit: 0, total_spent: 0.01, insight: '1 budget is over.',
      rows: [{ label: 'Dining', period, spent: 0.01, limit: 0, over: true }],
    });
  });

  it.each(PERIODS)('keeps an unspent zero %s budget on track', async (period) => {
    const h = household();
    await h.save(0, period);
    expect(await h.read()).toMatchObject({
      ok: true, summary: expect.stringContaining('All 1 budget on track'),
      data: { total_limit: 0, total_spent: 0, over_count: 0,
        budgets: [{ spent: 0, limit: 0, remaining: 0, pct: 0, over: false, transaction_count: 0 }] },
    });
  });

  it.each([
    { spent: 0.99, remaining: 0.01, pct: 99, over: false },
    { spent: 1, remaining: 0, pct: 100, over: false },
    { spent: 1.01, remaining: -0.01, pct: 101, over: true },
  ])('preserves the positive-limit boundary at $spent dollars', async ({ spent, remaining, pct, over }) => {
    const h = household();
    await h.save(1);
    h.db.seed('transactions', [expense('positive-limit', spent)]);
    expect(await h.read()).toMatchObject({ ok: true, data: {
      total_limit: 1, total_spent: spent, over_count: over ? 1 : 0,
      budgets: [{ limit: 1, spent, remaining, pct, over }],
    } });
  });

  it.each([
    { period: 'weekly', date: '2026-10-09', monthSpent: 5 },
    { period: 'monthly', date: '2026-09-30', monthSpent: 0 },
    { period: 'yearly', date: '2025-12-31', monthSpent: 0 },
  ] as const)('does not count an expense outside the zero $period budget window', async ({ period, date, monthSpent }) => {
    const h = household();
    await h.save(0, period);
    h.db.seed('transactions', [expense('outside-window', 5, 'Dining', date)]);
    expect(await h.read()).toMatchObject({ ok: true, data: {
      over_count: 0, total_spent: monthSpent,
      budgets: [{ limit: 0, spent: 0, over: false, window: WINDOWS[period], transaction_count: 0 }],
    } });
  });

  it.each([
    { input: 0.004, saved: 0, over: true },
    { input: 0.006, saved: 0.01, over: false },
  ])('compares against the existing cent-rounded saved amount for $input', async ({ input, saved, over }) => {
    const h = household();
    expect(await h.save(input)).toMatchObject({ ok: true, data: { budget: { amount: saved } } });
    h.db.seed('transactions', [expense('rounded-limit', 0.01)]);
    expect(await h.read()).toMatchObject({ ok: true, data: {
      total_limit: saved, total_spent: 0.01, over_count: over ? 1 : 0,
      budgets: [{ limit: saved, spent: 0.01, over }],
    } });
  });

  it('lowering an existing weekly budget to zero preserves its period and changes its answer', async () => {
    const h = household();
    await h.save(25, 'weekly');
    h.db.seed('transactions', [expense('existing-spend', 1)]);
    expect(await h.read()).toMatchObject({ ok: true, data: { over_count: 0 } });
    expect(await updateBudget(h.scope, { category: 'Dining', amount: 0, period: null })).toMatchObject({
      ok: true, data: { created: false, previousAmount: 25, budget: { amount: 0, period: 'weekly' } },
    });
    expect(h.db.table('budgets')).toHaveLength(1);
    expect(await h.read()).toMatchObject({ ok: true, data: {
      over_count: 1, budgets: [{ period: 'weekly', limit: 0, spent: 1, over: true }],
    } });
  });

  it('counts the zero limit while keeping mixed-period monthly totals and other categories intact', async () => {
    const h = household();
    await h.save(0);
    await h.save(120, 'weekly', 'Groceries');
    await h.save(1200, 'yearly', 'Travel');
    h.db.seed('transactions', [
      expense('dining', 0.01), expense('groceries-early', 200, 'Groceries', '2026-10-02'),
      expense('groceries-current', 100, 'groceries'), expense('travel-earlier', 1000, 'Travel', '2026-03-01'),
      expense('travel-current', 50, 'Travel'), expense('unbudgeted', 500, 'Other'),
    ]);
    expect(await h.read()).toMatchObject({ ok: true, data: {
      total_limit: 620, total_spent: 350.01, over_count: 1,
      budgets: expect.arrayContaining([
        expect.objectContaining({ category: 'Dining', spent: 0.01, limit: 0, over: true }),
        expect.objectContaining({ category: 'Groceries', spent: 100, limit: 120, over: false }),
        expect.objectContaining({ category: 'Travel', spent: 1050, limit: 1200, over: false }),
      ]),
    } });
  });

  it('does not admit another family, income or transfer into a zero budget', async () => {
    const h = household();
    await h.save();
    h.db.seed('budgets', [{
      id: 'foreign-budget', family_id: 'other-family', category: 'Private', amount: 0, period: 'monthly',
    }]);
    h.db.seed('transactions', [
      { ...expense('foreign', 100), family_id: 'other-family' },
      { ...expense('income', 100), type: 'income' }, { ...expense('transfer', 100), type: 'transfer' },
    ]);
    expect(await h.read()).toMatchObject({ ok: true, data: {
      total_limit: 0, total_spent: 0, over_count: 0,
      budgets: [{ category: 'Dining', spent: 0, over: false, transaction_count: 0 }],
    } });
  });
});

describe('zero budgets retain the existing permission and failure boundaries', () => {
  it.each(['child', 'teen', 'caregiver', 'guest'] as const)('refuses a %s through both the real tool gate and direct service', async (role) => {
    const h = household();
    await h.save();
    h.db.seed('transactions', [expense('private-spend', 0.01)]);
    h.from.mockClear();
    expect(await h.read({ role })).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await budgetVsActual({ ...h.scope, role })).toMatchObject({ ok: false, code: 'denied' });
    expect(await updateBudget({ ...h.scope, role }, { category: 'Dining', amount: 10 })).toMatchObject({ ok: false, code: 'denied' });
    expect(h.from.mock.calls.filter(([table]) => table === 'budgets' || table === 'transactions')).toEqual([]);
    expect(h.db.table('budgets')).toEqual([expect.objectContaining({ amount: 0 })]);
  });

  it.each(['budgets', 'transactions'])('a refused %s read cannot become an on-track answer', async (table) => {
    const h = household();
    await h.save();
    h.db.seed('transactions', [expense('unread-spend', 0.01)]);
    const client = withFaults(h.scope.db, (name) => name === table ? { code: '42501', message: 'Synthetic read refusal' } : null);
    const result = await h.read({ db: client });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
    expect(result).not.toHaveProperty('summary');
    expect(cardFromToolResult(NAME, {}, result)).toBeNull();
  });

  it('keeps the no-budgets answer distinct from a saved zero budget', async () => {
    const h = household();
    h.db.seed('transactions', [expense('no-budget-spend', 1)]);
    expect(await h.read()).toMatchObject({ ok: true, summary: 'No budgets are set up yet', data: {
      budgets: [], over_count: 0, total_limit: 0, total_spent: 0,
    } });
    expect(h.db.table('budgets')).toEqual([]);
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY])('continues to refuse invalid budget amount %s', async (amount) => {
    const h = household();
    expect(await updateBudget(h.scope, { category: 'Dining', amount })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(h.db.table('budgets')).toEqual([]);
    expect(h.from).not.toHaveBeenCalled();
  });
});
