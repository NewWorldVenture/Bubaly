// lib/operating-index/inputs.ts — pure helpers that turn raw finance rows into
// the Family Operating Index's financial signals. Kept DOM/Supabase-free so the
// period math (weekly/monthly/yearly budget windows) is unit-testable; the
// server reads the rows and calls these.
//
// A budget is judged in its OWN period on the FAMILY's day, both ends: Sunday
// to Saturday, the month or the year (lib/finance/budget-periods periodWindow),
// as the Budget Planner, the finance service and the twin judge it. The period
// used to start on Greenwich's day with Monday weeks and had no end, so next
// month's rent recorded today as scheduled was this month's overspend. And one
// budget per category, the one the finance service edits (budgetByCategory):
// judging every row counted a category over against a legacy duplicate's
// smaller limit that the family's own budget was not over.

import type { BudgetPeriod } from '@/lib/database.types';
import { budgetByCategory, periodWindow } from '@/lib/finance/budget-periods';

export interface BudgetRow { id: string; category: string; amount: number; period: BudgetPeriod; created_at?: string | null }
export interface ExpenseRow { category: string | null; amount: number; date: string } // date = 'YYYY-MM-DD'

const PERIODS: readonly BudgetPeriod[] = ['weekly', 'monthly', 'yearly'];

/**
 * Every day a budget's CURRENT period can cover on `today` (the family's day
 * key, YYYY-MM-DD): from the earliest window's first day to the latest one's
 * last. A Sunday week can begin in December or end in January, so this is not
 * always the year. The server reads expenses over exactly this, so no budget is
 * judged on part of its period and nothing after it is read.
 */
export function budgetWindowSpan(today: string): { from: string; to: string } {
  const windows = PERIODS.map((period) => periodWindow(period, today));
  return {
    from: windows.reduce((min, w) => (w.from < min ? w.from : min), windows[0].from),
    to: windows.reduce((max, w) => (w.to > max ? w.to : max), windows[0].to),
  };
}

/** One budget per category, the one the finance service edits and reports. */
export function canonicalBudgets<T extends BudgetRow>(budgets: readonly T[]): T[] {
  return [...budgetByCategory(budgets).values()];
}

function norm(c: string | null | undefined): string { return (c ?? '').trim().toLowerCase(); }

/**
 * How many budget categories are over their cap for the CURRENT period. For
 * each category's budget, sums expenses in the same (case-insensitive)
 * category dated within that budget's period on `today`, both ends, and counts
 * the budget when the spend exceeds the cap. Deterministic; ignores
 * non-positive caps.
 */
export function countOverspentBudgets(budgets: BudgetRow[], expenses: ExpenseRow[], today: string): number {
  let over = 0;
  for (const b of canonicalBudgets(budgets)) {
    if (!b.amount || b.amount <= 0) continue;
    const { from, to } = periodWindow(b.period, today);
    const cat = norm(b.category);
    let spent = 0;
    for (const e of expenses) {
      if (e.date >= from && e.date <= to && norm(e.category) === cat) spent += Number(e.amount) || 0;
    }
    if (spent > b.amount) over += 1;
  }
  return over;
}
