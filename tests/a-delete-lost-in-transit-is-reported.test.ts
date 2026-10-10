import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleAction } from '@/lib/ui/settle-action';

// A server-action call can REJECT rather than answer `{ ok: false }`: the
// network drops, the request times out, a redeploy loses the action id, or the
// money actions' `moneyScope()` throws outside their try. The billing, budgets
// and savings delete handlers awaited the call bare inside onClick, so the
// rejection went unhandled: no toast, no refresh, and the person could not tell
// whether the transaction, budget or savings goal was gone.

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('settleAction', () => {
  it('reports a rejected call and re-reads the list', async () => {
    const report = vi.fn();
    const refresh = vi.fn();
    const res = await settleAction(() => Promise.reject(new TypeError('Failed to fetch')), 'Could not remove that budget.', report, refresh);
    expect(res).toBeNull();
    expect(report).toHaveBeenCalledWith('Network problem — check your connection and try again.');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not hand a raw coded error to the person', async () => {
    const report = vi.fn();
    await settleAction(() => Promise.reject(Object.assign(new Error('relation "x" detail'), { code: 'XX000' })), 'Could not remove that budget.', report);
    expect(report).toHaveBeenCalledWith('Could not remove that budget.');
  });

  it('passes an answered result through untouched', async () => {
    const report = vi.fn();
    const refresh = vi.fn();
    const answer = { ok: false as const, error: 'refused' };
    expect(await settleAction(() => Promise.resolve(answer), 'fallback', report, refresh)).toBe(answer);
    expect(report).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('every money delete handler settles its call', () => {
  const cases: [string, string, string][] = [
    ['components/modules/billing-module.tsx', 'deleteTransactionAction', 'refreshTransactions'],
    ['components/modules/billing-module.tsx', 'deleteBudgetAction', 'refreshBudgets'],
    ['components/modules/billing-module.tsx', 'deleteSavingsGoalAction', 'refreshGoals'],
    ['components/finance/budgets-view.tsx', 'deleteBudgetAction', 'refreshBudgets'],
    ['components/finance/savings-view.tsx', 'deleteSavingsGoalAction', 'refresh'],
  ];
  it.each(cases)('%s awaits %s through settleAction', (file, action, refresh) => {
    const src = readFileSync(file, 'utf8');
    expect(src, 'a bare await of the action').not.toMatch(new RegExp(`await ${action}\\(`));
    expect(src).toMatch(new RegExp(`await settleAction\\(\\(\\) => ${action}\\(id\\), t?r?\\('actions\\.couldNotRemove\\w+'\\), toastError, ${refresh}\\);\\n\\s+if \\(!res\\) return;`));
  });
});
