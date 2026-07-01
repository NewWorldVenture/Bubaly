// lib/finances/overview.ts
// Pure, deterministic aggregations that power the Finances Overview dashboard:
// month totals (balance/income/expenses/savings + deltas), category spend
// breakdown, per-account monthly change, budget progress, and spending-by-person.
// No DB/network — every function is a pure transform of already-fetched rows so
// the math is unit-tested directly and reused by the client module.

export type TxLike = {
  account_id: string | null;
  member_id: string | null;
  amount: number;
  category: string | null;
  date: string;
  type: string; // 'income' | 'expense' | 'transfer'
};

export type AccountLike = { id: string; balance: number | null };
export type BudgetLike = { id: string; category: string; amount: number };
export type MemberLike = { id: string; display_name: string; color: string | null };

/** True when `date` (ISO/date string) falls in the given month/year. */
export function inMonth(date: string, month: number, year: number): boolean {
  const d = new Date(date);
  return d.getMonth() === month && d.getFullYear() === year;
}

export function sumExpenses(tx: TxLike[]): number {
  return tx.filter((t) => t.type === 'expense').reduce((s, t) => s + Math.abs(t.amount), 0);
}
export function sumIncome(tx: TxLike[]): number {
  return tx.filter((t) => t.type === 'income').reduce((s, t) => s + Math.abs(t.amount), 0);
}

export type OverviewTotals = {
  totalBalance: number;
  income: number;
  expenses: number;
  savings: number;
  incomeDelta: number;   // this month vs last month
  expensesDelta: number;
  balanceDelta: number;  // net cash flow this month (income - expenses)
};

/**
 * Headline stat-card numbers. `now` selects the "current" month; the previous
 * calendar month is used for the deltas.
 */
export function computeTotals(accounts: AccountLike[], tx: TxLike[], now: Date = new Date()): OverviewTotals {
  const m = now.getMonth();
  const y = now.getFullYear();
  const prev = new Date(y, m - 1, 1);
  const pm = prev.getMonth();
  const py = prev.getFullYear();

  const thisMonth = tx.filter((t) => inMonth(t.date, m, y));
  const lastMonth = tx.filter((t) => inMonth(t.date, pm, py));

  const totalBalance = accounts.reduce((s, a) => s + (a.balance ?? 0), 0);
  const income = sumIncome(thisMonth);
  const expenses = sumExpenses(thisMonth);
  const savings = income - expenses;

  return {
    totalBalance,
    income,
    expenses,
    savings,
    incomeDelta: income - sumIncome(lastMonth),
    expensesDelta: expenses - sumExpenses(lastMonth),
    balanceDelta: savings,
  };
}

// Category → brand color + emoji, used by the donut + breakdown list.
export const CATEGORY_COLORS: Record<string, string> = {
  Housing: '#7c5dff', Groceries: '#34d399', Transportation: '#fbbf24', Transport: '#fbbf24',
  'Dining Out': '#f472b6', Dining: '#f472b6', Utilities: '#60a5fa', Kids: '#22d3ee',
  Entertainment: '#a78bfa', Health: '#fb923c', Shopping: '#f9a8d4', Subscriptions: '#38bdf8',
  Insurance: '#4ade80', 'Auto & Gas': '#facc15', Education: '#818cf8', Other: '#94a3b8',
};
export const CATEGORY_EMOJI: Record<string, string> = {
  Housing: '🏠', Groceries: '🛒', Transportation: '🚗', Transport: '🚗', 'Dining Out': '🍴',
  Dining: '🍴', Utilities: '💡', Kids: '🧒', Entertainment: '🎮', Health: '💊', Shopping: '🛍️',
  Subscriptions: '📺', Insurance: '🛡️', 'Auto & Gas': '⛽', Education: '🎓', Other: '📦',
};
export const categoryColor = (c: string): string => CATEGORY_COLORS[c] ?? CATEGORY_COLORS.Other;
export const categoryEmoji = (c: string): string => CATEGORY_EMOJI[c] ?? CATEGORY_EMOJI.Other;

export type CategorySlice = { label: string; amount: number; pct: number; color: string; emoji: string };

/**
 * Expense spend grouped by category, sorted high→low, with rounded percentages.
 * `limit` collapses the long tail into an "Other" slice so the donut stays legible.
 */
export function categorySpend(tx: TxLike[], limit = 7): CategorySlice[] {
  const by: Record<string, number> = {};
  for (const t of tx) {
    if (t.type !== 'expense') continue;
    const cat = t.category || 'Other';
    by[cat] = (by[cat] ?? 0) + Math.abs(t.amount);
  }
  const total = Object.values(by).reduce((s, v) => s + v, 0);
  if (total === 0) return [];
  const sorted = Object.entries(by).sort(([, a], [, b]) => b - a);
  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  if (tail.length) {
    const tailSum = tail.reduce((s, [, v]) => s + v, 0);
    const existing = head.find(([k]) => k === 'Other');
    if (existing) existing[1] += tailSum;
    else head.push(['Other', tailSum]);
  }
  return head
    .sort(([, a], [, b]) => b - a)
    .map(([label, amount]) => ({
      label, amount, pct: Math.round((amount / total) * 100), color: categoryColor(label), emoji: categoryEmoji(label),
    }));
}

/** Net change for one account this month (income − expenses on its transactions). */
export function accountMonthlyChange(accountId: string, tx: TxLike[], now: Date = new Date()): number {
  const m = now.getMonth();
  const y = now.getFullYear();
  let net = 0;
  for (const t of tx) {
    if (t.account_id !== accountId || !inMonth(t.date, m, y)) continue;
    if (t.type === 'income') net += Math.abs(t.amount);
    else if (t.type === 'expense') net -= Math.abs(t.amount);
  }
  return net;
}

export type BudgetRow = BudgetLike & { spent: number; pct: number; over: boolean };

/** Per-budget spend + progress from this month's expense transactions. */
export function budgetProgress(budgets: BudgetLike[], tx: TxLike[]): BudgetRow[] {
  const spentBy: Record<string, number> = {};
  for (const t of tx) {
    if (t.type !== 'expense') continue;
    const cat = t.category || 'Other';
    spentBy[cat] = (spentBy[cat] ?? 0) + Math.abs(t.amount);
  }
  return budgets.map((b) => {
    const spent = spentBy[b.category] ?? 0;
    return { ...b, spent, pct: b.amount > 0 ? Math.min(Math.round((spent / b.amount) * 100), 100) : 0, over: spent > b.amount };
  });
}

/** Total spent + total budgeted across all budgets (drives the progress bar). */
export function budgetTotals(budgets: BudgetLike[], tx: TxLike[]): { spent: number; total: number; pct: number } {
  const rows = budgetProgress(budgets, tx);
  const spent = rows.reduce((s, r) => s + r.spent, 0);
  const total = budgets.reduce((s, b) => s + b.amount, 0);
  return { spent, total, pct: total > 0 ? Math.min(Math.round((spent / total) * 100), 100) : 0 };
}

export type PersonSpend = { member: MemberLike; amount: number; pct: number };

/**
 * Expense spend attributed to each member (via transactions.member_id), sorted
 * high→low. Members with no spend are dropped; percentages are of the attributed
 * total. Unattributed expenses (null member_id) are ignored.
 */
export function spendingByPerson(tx: TxLike[], members: MemberLike[]): PersonSpend[] {
  const by = new Map<string, number>();
  for (const t of tx) {
    if (t.type !== 'expense' || !t.member_id) continue;
    by.set(t.member_id, (by.get(t.member_id) ?? 0) + Math.abs(t.amount));
  }
  const total = [...by.values()].reduce((s, v) => s + v, 0);
  if (total === 0) return [];
  return members
    .map((member) => ({ member, amount: by.get(member.id) ?? 0 }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .map((r) => ({ ...r, pct: Math.round((r.amount / total) * 100) }));
}

/** A short, data-driven money tip comparing dining-out spend month-over-month. */
export function moneyTip(tx: TxLike[], now: Date = new Date()): string | null {
  const m = now.getMonth();
  const y = now.getFullYear();
  const prev = new Date(y, m - 1, 1);
  const cat = (t: TxLike) => (t.category === 'Dining Out' || t.category === 'Dining');
  const thisDining = sumExpenses(tx.filter((t) => inMonth(t.date, m, y) && cat(t)));
  const lastDining = sumExpenses(tx.filter((t) => inMonth(t.date, prev.getMonth(), prev.getFullYear()) && cat(t)));
  if (lastDining === 0) return null;
  const change = Math.round(((thisDining - lastDining) / lastDining) * 100);
  if (change <= -5) return `You've spent ${Math.abs(change)}% less on dining out this month compared to last month. Great job! 🎉`;
  if (change >= 15) return `Dining out is up ${change}% versus last month — a home-cooked week could rein it in.`;
  return null;
}
