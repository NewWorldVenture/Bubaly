// lib/finance/budget-periods.ts — a budget's period as day keys, and a budget's
// limit as its share of a month. Pure day-key arithmetic, with no local
// calendar read anywhere, so the server paths (the savings coach, Family CFO,
// the finance service) and the browser ones (the Budget Planner, Finances)
// share it and answer the same for the same family day.

export type BudgetPeriodName = 'weekly' | 'monthly' | 'yearly';

/** `YYYY-MM-DD` from a Date's UTC parts: day-key arithmetic, never anyone's clock. */
function utcKey(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The WHOLE budget period a calendar day falls in, both ends: Sunday to
 * Saturday, the 1st to the month's last day, or 1 January to 31 December.
 * lib/finance/hub.ts `periodStart` is its first day.
 */
export function periodWindow(period: BudgetPeriodName, dayKey: string): { from: string; to: string } {
  const [y, m, d] = dayKey.split('-').map(Number);
  if (period === 'yearly') return { from: `${dayKey.slice(0, 4)}-01-01`, to: `${dayKey.slice(0, 4)}-12-31` };
  if (period === 'monthly') return { from: `${dayKey.slice(0, 7)}-01`, to: utcKey(new Date(Date.UTC(y, m, 0))) };
  const back = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { from: utcKey(new Date(Date.UTC(y, m - 1, d - back))), to: utcKey(new Date(Date.UTC(y, m - 1, d - back + 6))) };
}

/**
 * A budget's limit as its share of one month: a weekly limit times 52/12, a
 * yearly one divided by 12. Adding the raw limits of budgets with different
 * periods and setting the sum against a month of spending made one yearly
 * budget enough to read an overspent month as "On track".
 */
export function monthlyBudgetShare(amount: number, period: string): number {
  if (period === 'weekly') return (amount * 52) / 12;
  if (period === 'yearly') return amount / 12;
  return amount;
}

export interface BudgetRowLike { id: string; category: string; amount: number; period: string; created_at?: string | null }

/**
 * One budget per category, keyed by its lower-cased, trimmed name: the OLDEST
 * row (created_at, then id), which is the one the finance service edits and
 * reports (lib/services/finances canonicalBudgets). A legacy duplicate must not
 * stand in for the budget the parent last changed, and a transaction recorded
 * as "groceries" belongs to the "Groceries" budget.
 */
export function budgetByCategory<T extends BudgetRowLike>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  const older = (a: T, b: T) => {
    const ac = a.created_at ?? '', bc = b.created_at ?? '';
    return ac !== bc ? ac < bc : a.id < b.id;
  };
  for (const row of rows) {
    const key = row.category.trim().toLowerCase();
    const held = out.get(key);
    if (!held || older(row, held)) out.set(key, row);
  }
  return out;
}
