// lib/finance/hub.ts — pure, tested helpers for the Finances sub-pages
// (Budget Planner, Bill Manager, Auto Pay, Due Reminders, Savings, Payments).
// No Supabase/React. Amounts are dollars (numeric), matching the finance tables.

export function usd(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount ?? 0);
}

export type DueStatus = 'paid' | 'overdue' | 'due_soon' | 'upcoming';

export interface BillLike { due_date: string; status: string }

/** Classify a bill by paid state + how close its due date is (7-day window). */
export function billDueStatus(bill: BillLike, now: Date = new Date()): DueStatus {
  if (bill.status === 'paid') return 'paid';
  const due = new Date(bill.due_date.length === 10 ? `${bill.due_date}T00:00:00` : bill.due_date);
  if (Number.isNaN(due.getTime())) return 'upcoming';
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDue = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  const days = Math.round((startDue - startToday) / 86400000);
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due_soon';
  return 'upcoming';
}

export const DUE_META: Record<DueStatus, { label: string; tint: string }> = {
  paid: { label: 'Paid', tint: 'bg-emerald-500/15 text-emerald-300' },
  overdue: { label: 'Overdue', tint: 'bg-rose-500/15 text-rose-300' },
  due_soon: { label: 'Due soon', tint: 'bg-amber-500/15 text-amber-300' },
  upcoming: { label: 'Upcoming', tint: 'bg-blue-500/15 text-blue-300' },
};

export type Period = 'weekly' | 'monthly' | 'yearly';

/** ISO date (YYYY-MM-DD) for the start of the current budget period. */
export function periodStart(period: Period, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'weekly') { d.setDate(d.getDate() - d.getDay()); }
  else if (period === 'monthly') { d.setDate(1); }
  else { d.setMonth(0, 1); }
  return d.toISOString().slice(0, 10);
}

export interface TxnLike { type: string; category: string | null; amount: number; date: string }

/** Total expense spend for a category within the current period. */
export function budgetSpent(txns: TxnLike[], category: string, period: Period, now: Date = new Date()): number {
  const start = periodStart(period, now);
  const cat = category.toLowerCase();
  let sum = 0;
  for (const t of txns) {
    if (t.type !== 'expense') continue;
    if ((t.category ?? '').toLowerCase() !== cat) continue;
    if (t.date < start) continue;
    sum += Math.abs(t.amount);
  }
  return Math.round(sum * 100) / 100;
}

export function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

export function fmtDueDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
