// lib/operating-index/inputs.ts — pure helpers that turn raw finance rows into
// the Family Operating Index's financial signals. Kept DOM/Supabase-free so the
// period math (weekly/monthly/yearly budget windows) is unit-testable; the
// server reads the rows and calls these. Everything is UTC to match asOfDate().

import type { BudgetPeriod } from '@/lib/database.types';

export interface BudgetRow { category: string; amount: number; period: BudgetPeriod }
export interface ExpenseRow { category: string | null; amount: number; date: string } // date = 'YYYY-MM-DD'

/** Start (YYYY-MM-DD, UTC) of the current window for a budget period. */
export function periodWindowStart(period: BudgetPeriod, now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'yearly') return `${d.getUTCFullYear()}-01-01`;
  if (period === 'monthly') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  // weekly → Monday of the current week
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function norm(c: string | null | undefined): string { return (c ?? '').trim().toLowerCase(); }

/**
 * How many budget categories are over their cap for the CURRENT period. For
 * each budget, sums expenses in the same (case-insensitive) category on/after
 * that budget's period start, and counts the budget when the spend exceeds the
 * cap. Deterministic; ignores non-positive caps.
 */
export function countOverspentBudgets(budgets: BudgetRow[], expenses: ExpenseRow[], now: Date = new Date()): number {
  let over = 0;
  for (const b of budgets) {
    if (!b.amount || b.amount <= 0) continue;
    const start = periodWindowStart(b.period, now);
    const cat = norm(b.category);
    let spent = 0;
    for (const e of expenses) {
      if (e.date >= start && norm(e.category) === cat) spent += Number(e.amount) || 0;
    }
    if (spent > b.amount) over += 1;
  }
  return over;
}

/** The earliest window start across a set of budgets — how far back the server
 *  must fetch expenses to evaluate every budget's current period. */
export function earliestWindowStart(budgets: BudgetRow[], now: Date = new Date()): string | null {
  if (budgets.length === 0) return null;
  return budgets.map((b) => periodWindowStart(b.period, now)).sort()[0];
}
