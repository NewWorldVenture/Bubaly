// Vacation budget rollups + overrun detection — pure, unit-tested.
import type { VacBudgetCategory } from '@/lib/database.types';

export type BudgetLike = { category: VacBudgetCategory; planned_cents: number };
export type ExpenseLike = { category: VacBudgetCategory; amount_cents: number };

export type CategoryRollup = {
  category: VacBudgetCategory;
  planned_cents: number;
  spent_cents: number;
  remaining_cents: number;
  pct: number;          // 0..>100 (spent / planned)
  over: boolean;
};

export type BudgetSummary = {
  planned_cents: number;
  spent_cents: number;
  remaining_cents: number;
  pct: number;
  over: boolean;
  categories: CategoryRollup[];
};

/** Roll planned budgets + actual expenses into a per-category and overall summary. */
export function summarizeBudget(budgets: BudgetLike[], expenses: ExpenseLike[]): BudgetSummary {
  const cats = new Map<VacBudgetCategory, { planned: number; spent: number }>();
  for (const b of budgets) {
    const c = cats.get(b.category) ?? { planned: 0, spent: 0 };
    c.planned += b.planned_cents || 0;
    cats.set(b.category, c);
  }
  for (const e of expenses) {
    const c = cats.get(e.category) ?? { planned: 0, spent: 0 };
    c.spent += e.amount_cents || 0;
    cats.set(e.category, c);
  }
  const categories: CategoryRollup[] = [...cats.entries()]
    .map(([category, { planned, spent }]) => ({
      category,
      planned_cents: planned,
      spent_cents: spent,
      remaining_cents: planned - spent,
      pct: planned > 0 ? Math.round((spent / planned) * 100) : (spent > 0 ? 999 : 0),
      over: spent > planned && planned > 0,
    }))
    .sort((a, b) => b.planned_cents - a.planned_cents);

  const planned = categories.reduce((s, c) => s + c.planned_cents, 0);
  const spent = categories.reduce((s, c) => s + c.spent_cents, 0);
  return {
    planned_cents: planned,
    spent_cents: spent,
    remaining_cents: planned - spent,
    pct: planned > 0 ? Math.round((spent / planned) * 100) : (spent > 0 ? 999 : 0),
    over: spent > planned && planned > 0,
    categories,
  };
}

/** Categories that are over budget — drives AI/budget warnings. */
export function overruns(summary: BudgetSummary): CategoryRollup[] {
  return summary.categories.filter((c) => c.over);
}
