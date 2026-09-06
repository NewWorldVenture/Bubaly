// The finances service must never say a number that did not come from a row.
// These tests pin down: every query is family-scoped; a non-manager is refused
// before any read; sums are exact in cents; the pure analysis rules
// (category totals, period comparison, merchant movement, recurring
// changes, unusual charges) are explainable; empties are honest; and writes
// go to the right columns.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, TransactionType } from '@/lib/database.types';
import {
  budgetVsActual, budgetWindow, compareCategoryTotals, comparePeriods, createSavingsGoal, listTransactions, merchantMovement,
  merchantMovementRows, monthBounds, normalizeMerchant, previousRange, recurringChangeRows, recurringChanges, resolveRange,
  spendingByCategory, toCents, toDollars, totalsByCategory, unusualTransactionRows, unusualTransactions, updateBudget,
} from '@/lib/services/finances';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: chain,
      eq: filter, is: filter, in: filter, neq: (c: string, v: unknown) => filter(`neq:${c}`, v),
      ilike: (c: string, v: unknown) => filter(`ilike:${c}`, v),
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gt: (c: string, v: unknown) => filter(`gt:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra };
}

function txn(over: Partial<{ id: string; name: string; merchant: string | null; amount: number; category: string | null; date: string; type: TransactionType }>) {
  return {
    id: over.id ?? `t-${Math.random().toString(36).slice(2, 8)}`, family_id: 'fam-1', account_id: null, member_id: null,
    name: over.name ?? 'Store', merchant: over.merchant ?? null, amount: over.amount ?? 10, category: 'category' in over ? over.category ?? null : 'Groceries',
    date: over.date ?? '2026-09-01', type: over.type ?? ('expense' as const), status: 'posted', notes: null, created_by: 'auth-1',
    idempotency_key: null, fingerprint: null, source: 'manual', receipt_document_id: null,
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  };
}

describe('money and date helpers', () => {
  it('sums in integer cents so ten dimes make exactly a dollar', () => {
    expect(toCents(0.1) * 10).toBe(100);
    expect(toCents('12.345')).toBe(1235);
    expect(toCents(null)).toBe(0);
    expect(toDollars(123456)).toBe(1234.56);
  });

  it('resolves a default window of the last 30 family-local days', () => {
    const range = resolveRange(scopeWith({} as SupabaseClient<Database>));
    expect(range).toMatchObject({ ok: true, data: { from: '2026-08-07', to: '2026-09-05' } });
  });

  it('refuses an inverted or malformed window instead of returning an empty answer', () => {
    const scope = scopeWith({} as SupabaseClient<Database>);
    expect(resolveRange(scope, { from: '2026-09-10', to: '2026-09-01' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(resolveRange(scope, { from: 'last month' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('derives the previous window of the same length and month/budget bounds', () => {
    expect(previousRange({ from: '2026-09-01', to: '2026-09-30' })).toEqual({ from: '2026-08-02', to: '2026-08-31' });
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(budgetWindow('monthly', '2026-09-05')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(budgetWindow('weekly', '2026-09-05')).toEqual({ from: '2026-08-30', to: '2026-09-05' });
    expect(budgetWindow('yearly', '2026-09-05')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
});

describe('pure analysis', () => {
  it('totals expenses by category and ignores income and transfers', () => {
    const rows = [
      txn({ amount: 40.1, category: 'Groceries' }), txn({ amount: 9.9, category: 'groceries' }), txn({ amount: 100, category: 'Rent' }),
      txn({ amount: 5000, category: 'Salary', type: 'income' }), txn({ amount: 20, category: null }),
    ];
    const out = totalsByCategory(rows);
    expect(out.total).toBe(170);
    expect(out.categories[0]).toMatchObject({ category: 'Rent', spent: 100, count: 1 });
    // Category names are case-sensitive as stored; the budget comparison normalises, listings do not.
    expect(out.categories.find((c) => c.category === 'Uncategorized')).toMatchObject({ spent: 20 });
    expect(out.categories.reduce((s, c) => s + c.share, 0)).toBeGreaterThan(99);
  });

  it('compares two windows per category, biggest swing first, with null pct when nothing to compare', () => {
    const out = compareCategoryTotals(
      [txn({ amount: 150, category: 'Dining' }), txn({ amount: 50, category: 'Fuel' })],
      [txn({ amount: 100, category: 'Dining' })],
    );
    expect(out).toMatchObject({ current: 200, previous: 100, delta: 100, deltaPct: 100 });
    expect(out.categories[0]).toMatchObject({ category: 'Dining', delta: 50, deltaPct: 50 });
    expect(out.categories[1]).toMatchObject({ category: 'Fuel', delta: 50, deltaPct: null });
  });

  it('normalises merchant labels so store numbers do not split one shop into many', () => {
    expect(normalizeMerchant({ name: 'TARGET #1234', merchant: null })).toBe('target');
    expect(normalizeMerchant({ name: 'x', merchant: 'Shell Oil 57221' })).toBe('shell oil');
  });

  it('reports merchant movement with new/gone/up/down status', () => {
    const rows = merchantMovementRows(
      [txn({ name: 'Costco', amount: 300 }), txn({ name: 'New Cafe', amount: 20 })],
      [txn({ name: 'Costco #55', amount: 200 }), txn({ name: 'Old Gym', amount: 40 })],
    );
    expect(rows.find((r) => r.merchant === 'costco')).toMatchObject({ current: 300, previous: 200, delta: 100, status: 'up' });
    expect(rows.find((r) => r.merchant === 'new cafe')).toMatchObject({ status: 'new' });
    expect(rows.find((r) => r.merchant === 'old gym')).toMatchObject({ status: 'gone', current: 0 });
  });

  it('flags a recurring charge only when it repeats across months and the amount moved', () => {
    const rows = [
      txn({ name: 'Netflix', amount: 15.49, date: '2026-07-03' }), txn({ name: 'Netflix', amount: 15.49, date: '2026-08-03' }), txn({ name: 'Netflix', amount: 17.99, date: '2026-09-03' }),
      txn({ name: 'Water Co', amount: 60, date: '2026-08-10' }), txn({ name: 'Water Co', amount: 61, date: '2026-09-10' }),
      txn({ name: 'Coffee', amount: 4, date: '2026-09-01' }), txn({ name: 'Coffee', amount: 9, date: '2026-09-02' }),
    ];
    const changes = recurringChangeRows(rows);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ merchant: 'netflix', latestAmount: 17.99, previousAmount: 15.49, delta: 2.5, months: ['2026-07', '2026-08', '2026-09'] });
  });

  it('explains every unusual transaction against the baseline', () => {
    const baseline = [30, 35, 40, 32, 38].map((amount, i) => txn({ name: 'Grocer', amount, category: 'Groceries', date: `2026-08-0${i + 1}` }));
    const window = [
      txn({ id: 'big', name: 'Grocer', amount: 120, category: 'Groceries' }),
      txn({ id: 'normal', name: 'Grocer', amount: 36, category: 'Groceries' }),
      txn({ id: 'new', name: 'Fancy Bikes', amount: 400, category: 'Hobbies' }),
      txn({ id: 'small-new', name: 'Corner Shop', amount: 3, category: 'Groceries' }),
    ];
    const out = unusualTransactionRows(window, baseline);
    expect(out.map((u) => u.id)).toEqual(['new', 'big']);
    expect(out.find((u) => u.id === 'big')?.reason).toMatch(/more than double the usual \$35\.00 for Groceries/);
    expect(out.find((u) => u.id === 'new')?.reason).toMatch(/First charge from Fancy Bikes/);
  });

  it('returns honest empties when there are no rows', () => {
    expect(totalsByCategory([])).toEqual({ total: 0, categories: [] });
    expect(compareCategoryTotals([], [])).toMatchObject({ current: 0, previous: 0, delta: 0, deltaPct: null, categories: [] });
    expect(recurringChangeRows([])).toEqual([]);
    expect(unusualTransactionRows([], [])).toEqual([]);
  });
});

describe('reads against rows', () => {
  it('refuses a teen before touching the database', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    for (const fn of [listTransactions, spendingByCategory, comparePeriods, merchantMovement, recurringChanges, unusualTransactions]) {
      const res = await fn(scopeWith(db, { role: 'teen' }), {});
      expect(res).toMatchObject({ ok: false, code: 'denied' });
    }
    expect(await budgetVsActual(scopeWith(db, { role: 'child' }))).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('lets a system actor (cron/executor) read, family-scoped', async () => {
    const { db, calls } = makeDb(() => ({ data: [txn({ amount: 12.5 })], error: null }));
    const res = await listTransactions(scopeWith(db, { role: 'system', actorKind: 'system', userId: null, memberId: null }), { from: '2026-09-01', to: '2026-09-05' });
    expect(res).toMatchObject({ ok: true, data: { total: 12.5 } });
    expect(calls[0]).toMatchObject({ table: 'transactions', filters: { family_id: 'fam-1', 'gte:date': '2026-09-01', 'lte:date': '2026-09-05' } });
  });

  it('surfaces a database failure as ok:false with readable copy', async () => {
    const { db } = makeDb(() => ({ data: null, error: { code: '42501', message: 'permission denied for table transactions' } }));
    const res = await spendingByCategory(scopeWith(db));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('db');
      expect(res.error).toContain("don't have permission");
    }
  });

  it('measures each budget in its own window and reports the window', async () => {
    const rows = [
      txn({ amount: 450, category: 'groceries', date: '2026-09-02' }),
      txn({ amount: 80, category: 'Groceries', date: '2026-08-20' }),   // last month: outside the monthly window
      txn({ amount: 30, category: 'Fuel', date: '2026-09-04' }),        // inside this week
      txn({ amount: 30, category: 'Fuel', date: '2026-08-25' }),        // outside this week
    ];
    const { db, calls } = makeDb((call) => (call.table === 'budgets'
      ? { data: [
        { id: 'b-1', family_id: 'fam-1', category: 'Groceries', amount: 400, period: 'monthly', created_by: null, created_at: '', updated_at: '' },
        { id: 'b-2', family_id: 'fam-1', category: 'Fuel', amount: 50, period: 'weekly', created_by: null, created_at: '', updated_at: '' },
      ], error: null }
      : { data: rows, error: null }));
    const res = await budgetVsActual(scopeWith(db));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.month).toBe('2026-09');
    const groceries = res.data.budgets.find((b) => b.category === 'Groceries');
    expect(groceries).toMatchObject({ limit: 400, spent: 450, remaining: -50, pct: 113, over: true, window: { from: '2026-09-01', to: '2026-09-30' }, transactionCount: 1 });
    const fuel = res.data.budgets.find((b) => b.category === 'Fuel');
    expect(fuel).toMatchObject({ limit: 50, spent: 30, over: false, window: { from: '2026-08-30', to: '2026-09-05' } });
    expect(res.data.overCount).toBe(1);
    expect(calls.every((c) => c.filters.family_id === 'fam-1')).toBe(true);
  });

  it('returns an empty budget list rather than inventing one', async () => {
    const { db } = makeDb(() => ({ data: [], error: null }));
    const res = await budgetVsActual(scopeWith(db), { month: '2026-08' });
    expect(res).toMatchObject({ ok: true, data: { month: '2026-08', budgets: [], totalLimit: 0, totalSpent: 0, overCount: 0 } });
  });

  it('rejects a malformed month', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    expect(await budgetVsActual(scopeWith(db), { month: 'September' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('reads the baseline from the days before the window for unusual charges', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    const res = await unusualTransactions(scopeWith(db), { from: '2026-09-01', to: '2026-09-05', baselineDays: 30 });
    expect(res).toMatchObject({ ok: true, data: { baseline: { from: '2026-08-02', to: '2026-08-31' }, unusual: [] } });
    expect(calls.map((c) => c.filters['gte:date']).sort()).toEqual(['2026-08-02', '2026-09-01']);
  });
});

describe('writes', () => {
  it('updates an existing budget matched case-insensitively and reports the previous amount', async () => {
    const existing = { id: 'b-1', family_id: 'fam-1', category: 'Groceries', amount: 400, period: 'monthly', created_by: null, created_at: '', updated_at: '' };
    const { db, calls } = makeDb((call) => (call.kind === 'update' ? { data: { ...existing, amount: 500 }, error: null } : { data: existing, error: null }));
    const res = await updateBudget(scopeWith(db), { category: 'groceries', amount: 500 });
    expect(res).toMatchObject({ ok: true, data: { created: false, previousAmount: 400 } });
    const update = calls.find((c) => c.kind === 'update');
    expect(update?.filters).toMatchObject({ id: 'b-1', family_id: 'fam-1' });
    expect(update?.payload).toEqual({ amount: 500 });
  });

  it('creates a budget when none exists, defaulting to monthly', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert'
      ? { data: { id: 'b-new', family_id: 'fam-1', category: 'Fuel', amount: 120, period: 'monthly', created_by: 'auth-1', created_at: '', updated_at: '' }, error: null }
      : { data: null, error: null }));
    const res = await updateBudget(scopeWith(db), { category: 'Fuel', amount: 120 });
    expect(res).toMatchObject({ ok: true, data: { created: true, previousAmount: null } });
    expect(calls.find((c) => c.kind === 'insert')?.payload).toEqual({ family_id: 'fam-1', category: 'Fuel', amount: 120, period: 'monthly', created_by: 'auth-1' });
  });

  it('rejects a negative budget and an empty category before any query', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await updateBudget(scopeWith(db), { category: '', amount: 10 })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await updateBudget(scopeWith(db), { category: 'Fuel', amount: -1 })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('creates a savings goal with dollar columns and the auth user id', async () => {
    const goal = { id: 'g-1', family_id: 'fam-1', name: 'Summer trip', target_amount: 2500, current_amount: 0, target_date: '2027-06-01', emoji: '🎯', created_by: 'auth-1', created_at: '', updated_at: '' };
    const { db, calls } = makeDb((call) => (call.kind === 'insert' ? { data: goal, error: null } : { data: null, error: null }));
    const res = await createSavingsGoal(scopeWith(db), { name: ' Summer trip ', targetAmount: 2500, targetDate: '2027-06-01' });
    expect(res).toMatchObject({ ok: true, data: { id: 'g-1' } });
    expect(calls.find((c) => c.kind === 'insert')?.payload).toEqual({ family_id: 'fam-1', name: 'Summer trip', target_amount: 2500, current_amount: 0, target_date: '2027-06-01', created_by: 'auth-1' });
  });

  it('returns the existing goal instead of a duplicate on a retried run', async () => {
    const goal = { id: 'g-1', family_id: 'fam-1', name: 'Summer trip', target_amount: 2500, current_amount: 0, target_date: null, emoji: null, created_by: 'auth-1', created_at: '', updated_at: '' };
    const { db, calls } = makeDb(() => ({ data: goal, error: null }));
    const res = await createSavingsGoal(scopeWith(db, { runId: 'run-1', stepId: 'step-1' }), { name: 'Summer trip', targetAmount: 2500 });
    expect(res).toMatchObject({ ok: true, data: { id: 'g-1' } });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
    expect(calls[0].filters.family_id).toBe('fam-1');
  });
});

describe('who may change the household budget (0267)', () => {
  // Seven reads in this service assert the reader gate and the two writes
  // asserted nothing. That mattered because 0267's RLS cannot see them: the
  // run executor writes with the SERVICE ROLE, so the database's new boundary
  // is bypassed on exactly the path the AI takes.
  const noWrite = { ok: false, code: 'denied' };

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('refuses a %s setting a budget', async (role) => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await updateBudget(scopeWith(db, { role }), { category: 'Snacks', amount: 400 })).toMatchObject(noWrite);
    expect(calls, 'a refusal that still touched the database is not a refusal').toHaveLength(0);
  });

  it.each(['teen', 'child'] as const)('refuses a %s opening a savings goal', async (role) => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await createSavingsGoal(scopeWith(db, { role }), { name: 'Bike', targetAmount: 300 })).toMatchObject(noWrite);
    expect(calls).toHaveLength(0);
  });

  it('says who can, rather than that something went wrong', async () => {
    const { db } = makeDb(() => ({ data: null, error: null }));
    const res = await updateBudget(scopeWith(db, { role: 'teen' }), { category: 'Snacks', amount: 400 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/parent or another adult/i);
  });

  it('still lets a cron do the household\'s own work', async () => {
    // `system` has no person to ask, and the trust gate has already decided
    // whether the work may happen — the same carve-out the read gate makes.
    const { db, calls } = makeDb((call) => (call.kind === 'insert'
      ? { data: { id: 'b-1', family_id: 'fam-1', category: 'Snacks', amount: 400, period: 'monthly' }, error: null }
      : { data: null, error: null }));
    const res = await updateBudget(scopeWith(db, { role: 'system', actorKind: 'system' }), { category: 'Snacks', amount: 400 });
    expect(res.ok, 'a system actor was refused its own household work').toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});
