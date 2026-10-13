// A money total is the whole window's, or it is not given.
//
// PostgREST answers ONE request with at most `db-max-rows` — 1,000 on a default
// Supabase project — whatever `.limit()` asks for, and says nothing about it.
// The finance analyses read their window with `.limit(5000)`, so a window with
// more than 1,000 expenses was summed from its newest 1,000 rows and reported
// as exact: a yearly $14,000 grocery budget with $15,000 spent read "All 1
// budget on track ($10,000.00 of $14,000.00)".
//
// Driven through `executeTool` — how the assistant engine and a spending-review
// run reach these tools — over an in-memory database that applies the same
// 1,000-row cap as the real server.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));

import { executeTool } from '@/lib/ai/tools/execute';

const FAMILY = '00000000-0000-4000-8000-0000000c2101';
const PARENT = { user: '00000000-0000-4000-8000-0000000c2102', member: '00000000-0000-4000-8000-0000000c2103' };
const NOW = '2026-10-05T18:00:00Z';

type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

const scope = (): ServiceScope => ({
  db, familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent', actorKind: 'ai', tz: 'America/Los_Angeles', now: new Date(NOW),
});

/** `count` grocery expenses of $10 each, `perDay` a day from 1 January, oldest first. */
function groceries(count: number, perDay = 6): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.UTC(2026, 0, 1) + Math.floor(i / perDay) * 86_400_000).toISOString().slice(0, 10);
    return {
      id: `t-${String(i).padStart(5, '0')}`, family_id: FAMILY, name: 'Market', merchant: 'Market', amount: 10,
      category: 'Groceries', date: day, type: 'expense', member_id: null, account_id: null,
    };
  });
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    maxRows: 1000,
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: { ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null } },
  }) as DB;
  holder.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: 'America/Los_Angeles' }]);
  db.seed('family_members', [{ id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' }]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute', category_behavior: {}, risk_overrides: {}, child_channels: {}, memory_enabled: true }]);
  db.seed('budgets', [{ id: 'b-1', family_id: FAMILY, category: 'Groceries', amount: 14_000, period: 'yearly', created_by: null, created_at: '2026-01-01T00:00:00Z' }]);
});

/** `count` $10 grocery expenses in October, before 'now' (the 5th), four a day from the 1st. */
function octoberGroceries(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t-oct-${String(i).padStart(3, '0')}`, family_id: FAMILY, name: 'Market', merchant: 'Market', amount: 10,
    category: 'Groceries', date: `2026-10-0${1 + Math.floor(i / 4)}`, type: 'expense', member_id: null, account_id: null,
  }));
}

describe('a yearly budget is judged on the whole year', () => {
  it('finances.budgetVsActual counts all 1,500 expenses, so a $15,000 year is over a $14,000 budget', async () => {
    // 1,480 from January to early September, then 20 in October: the year's
    // 1,500, past the server's 1,000-row cap.
    db.seed('transactions', [...groceries(1480), ...octoberGroceries(20)]);
    // October spending in a category with no budget is not budgeted spend.
    db.seed('transactions', [{
      id: 't-oct-dining', family_id: FAMILY, name: 'Cafe', merchant: 'Cafe', amount: 75,
      category: 'Dining', date: '2026-10-02', type: 'expense', member_id: null, account_id: null,
    }]);
    const out = await executeTool(scope(), 'finances.budgetVsActual', {});
    expect(out).toMatchObject({ status: 'ok' });
    if (out.status !== 'ok') return;
    // The line is the budget's own period, the whole year.
    expect((out.data as { budgets: unknown[] }).budgets).toEqual([expect.objectContaining({ spent: 15_000, over: true, transaction_count: 1500 })]);
    // The totals are October's: the yearly limit as its monthly share, against
    // the $200 of budgeted (Groceries) spending dated in October.
    const data = out.data as { month: string; total_spent: number; total_limit: number; over_count: number };
    expect(data).toMatchObject({ month: '2026-10', total_spent: 200, over_count: 1 });
    expect(data.total_limit).toBeCloseTo(14_000 / 12, 2);
  });

  it('the finances.budgetVsActual tool says its totals are the month\'s, with other periods as their monthly share', async () => {
    const { getTool } = await import('@/lib/ai/tools/registry');
    const tool = getTool('finances.budgetVsActual');
    expect(tool?.description).toMatch(/total_limit and total_spent are the month's/i);
    expect(tool?.description).toMatch(/weekly and yearly limits counted as their monthly share/i);
    db.seed('transactions', octoberGroceries(20));
    const out = await executeTool(scope(), 'finances.budgetVsActual', {});
    expect(out).toMatchObject({ status: 'ok' });
    if (out.status !== 'ok') return;
    // The one-line summary names the totals as the month's, not as plain totals.
    expect(out.summary).toBe('All 1 budget on track for 2026-10; the month\'s budgeted spending is $200.00 of $1,166.67 (weekly and yearly limits as their monthly share)');
  });

  it('finances.spendingByCategory over the year totals every expense in it', async () => {
    db.seed('transactions', groceries(1500));
    const out = await executeTool(scope(), 'finances.spendingByCategory', { from: '2026-01-01', to: '2026-10-05' });
    expect(out).toMatchObject({ status: 'ok', data: { total: 15_000, transaction_count: 1500 } });
  });

  it('a window past the ceiling is refused, not totalled from its newest rows', async () => {
    db.seed('transactions', groceries(5001, 20));
    const out = await executeTool(scope(), 'finances.budgetVsActual', {});
    expect(out.status).not.toBe('ok');
    if (out.status === 'ok') return;
    // The reason is the catalogue's sentence, never the paging helper's own text.
    expect(out).toMatchObject({ status: 'error', error: 'That period holds more transactions than Bubaly can total at once, so it gave no figure rather than a wrong one. Try a shorter period.' });
    expect(JSON.stringify(out)).not.toMatch(/readAll|PREFIX|max of/);
  });
});

describe('a listed page says whether it is the whole window', () => {
  it('finances.listTransactions honours a limit above the server cap and says the list is complete', async () => {
    db.seed('transactions', groceries(1500));
    const out = await executeTool(scope(), 'finances.listTransactions', { from: '2026-01-01', to: '2026-10-05', limit: 2000 });
    expect(out).toMatchObject({ status: 'ok', data: { total: 15_000, complete: true } });
    if (out.status !== 'ok') return;
    expect((out.data as { transactions: unknown[] }).transactions).toHaveLength(1500);
  });

  it('a page shorter than the window labels its total as the page\'s', async () => {
    db.seed('transactions', groceries(1500));
    const out = await executeTool(scope(), 'finances.listTransactions', { from: '2026-01-01', to: '2026-10-05', limit: 200 });
    expect(out).toMatchObject({ status: 'ok', data: { total: 2_000, complete: false } });
  });
});
