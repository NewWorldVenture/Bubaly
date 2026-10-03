// lib/finance/hub.ts — pure, tested helpers for the Finances sub-pages
// (Budget Planner, Bill Manager, Auto Pay, Due Reminders, Savings, Payments).
// No Supabase/React. Amounts are dollars (numeric), matching the finance tables.

import { DEFAULT_LOCALE, type LocaleCode } from '@/lib/i18n/locales';
import { localDayKey } from '@/lib/time/local-day';

/**
 * Dollars for the reader. The LOCALE is the reader's; the CURRENCY is the
 * money's own and stays USD — a family's bills are billed in dollars whatever
 * language the person looking at them reads.
 */
export function usd(amount: number, locale: LocaleCode = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(amount ?? 0);
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

// ── Recurring bills ──────────────────────────────────────────────────────────

export type BillCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

const CADENCES: Record<string, BillCadence> = {
  weekly: 'weekly', biweekly: 'biweekly', fortnightly: 'biweekly',
  monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly', annually: 'yearly',
};

export interface RecurringBillLike extends BillLike { is_recurring?: boolean | null; recurrence?: string | null }

/**
 * The cadence a bill repeats on, or null for a one-off.
 *
 * `recurrence` wins. A bill flagged `is_recurring` with NO cadence is what the
 * Bill Manager's add form wrote until it gained a cadence field (the Billing
 * module's form always recorded one). Such a bill is read as monthly — the
 * cadence that form now defaults to, and the one nearly every household bill
 * is on — rather than silently treated as a one-off that a payment closes.
 */
export function billCadence(bill: Pick<RecurringBillLike, 'is_recurring' | 'recurrence'>): BillCadence | null {
  const named = bill.recurrence ? CADENCES[bill.recurrence.toLowerCase()] ?? null : null;
  if (named) return named;
  return bill.is_recurring ? 'monthly' : null;
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})/;

/** `YYYY-MM-DD` → [year, month index, day], or null when it is not a real calendar day. */
function parseDayKey(key: string): [number, number, number] | null {
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo || probe.getUTCDate() !== d) return null;
  return [y, mo, d];
}

const dayKeyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The anchor stepped `n` periods on. A month step keeps the anchor's day of
 * month and clamps to a shorter month, so a bill due on the 31st falls on
 * Feb 28 and is back on Mar 31 — it is stepped from the anchor each time, not
 * from the clamped date.
 */
function stepFrom([y, mo, d]: [number, number, number], cadence: BillCadence, n: number): string {
  if (cadence === 'weekly' || cadence === 'biweekly') return dayKeyOf(Date.UTC(y, mo, d + n * (cadence === 'weekly' ? 7 : 14)));
  const months = n * (cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12);
  const lastDay = new Date(Date.UTC(y, mo + months + 1, 0)).getUTCDate();
  return dayKeyOf(Date.UTC(y, mo + months, Math.min(d, lastDay)));
}

/**
 * The next due date of a recurring bill once the occurrence on `dueDate` is
 * paid: the first occurrence of the series anchored at `dueDate` that falls
 * strictly after both `dueDate` and `today` (both `YYYY-MM-DD`).
 *
 * Paid early — today before the due date — the series keeps its anchor. Paid
 * late, or a bill whose due date went stale months ago, lands on the first
 * occurrence still ahead: marking a stale bill paid means "I am up to date",
 * not "I owe every month in between" (the forecast makes the same jump, see
 * lib/finance/timeline.ts). Null when `dueDate` is not a calendar day.
 */
export function nextBillDueDate(dueDate: string, cadence: BillCadence, today: string): string | null {
  const anchor = parseDayKey(dueDate);
  if (!anchor) return null;
  const due = dueDate.slice(0, 10);
  const floor = parseDayKey(today) && today.slice(0, 10) > due ? today.slice(0, 10) : due;
  // Day keys compare as text. 5000 weekly steps is close to a century.
  for (let n = 1; n <= 5000; n += 1) {
    const next = stepFrom(anchor, cadence, n);
    if (next > floor) return next;
  }
  return null;
}

export type BillPaidPatch = { status: 'paid' } | { status: 'upcoming'; due_date: string };

/**
 * What "Mark paid" writes.
 *
 * A one-off is paid and stays paid. A recurring bill is ONE row whose due
 * date rolls to the next occurrence and stays open. Marked `paid`, it vanished
 * from every "due soon" reader for good — the brief, the operating index, the
 * Due Reminders tab, the Finances card — because each of them reads
 * `status <> 'paid'`; a monthly bill was reminded about exactly once. The
 * forecast (lib/finance/timeline.ts) already treats a paid recurring bill as
 * still owing its later occurrences; this makes the list agree with it.
 */
export function billPaidPatch(bill: RecurringBillLike, today: string): BillPaidPatch {
  const cadence = billCadence(bill);
  const next = cadence ? nextBillDueDate(bill.due_date, cadence, today) : null;
  return next ? { status: 'upcoming', due_date: next } : { status: 'paid' };
}

// ── Subscriptions ───────────────────────────────────────────────────────────

/** The cadence a subscription is billed on: the module's four plus the forecast's aliases; anything else reads as monthly, as the forecast does. */
export function subscriptionCadence(cadence: string | null | undefined): BillCadence {
  return (cadence ? CADENCES[cadence.toLowerCase()] : undefined) ?? 'monthly';
}

/**
 * The first occurrence of the series anchored at `anchor` that falls ON OR
 * AFTER `today` — `anchor` itself while it has not passed. Null when `anchor`
 * is not a calendar day. (`nextBillDueDate` is the strictly-after sibling a
 * payment needs; a charge still coming today is still coming.)
 */
export function nextOccurrenceOnOrAfter(anchor: string, cadence: BillCadence, today: string): string | null {
  const start = parseDayKey(anchor);
  if (!start) return null;
  const from = anchor.slice(0, 10);
  const floor = parseDayKey(today) ? today.slice(0, 10) : from;
  if (from >= floor) return from;
  for (let n = 1; n <= 5000; n += 1) {
    const next = stepFrom(start, cadence, n);
    if (next >= floor) return next;
  }
  return null;
}

/**
 * Where a subscription's next charge falls TODAY.
 *
 * `subscriptions_tracked.next_charge` is typed in by hand and nothing rolls
 * it, so after its first cycle it is a date in the past. The autopilot's
 * "charge in N days" heads-up (lib/autopilot/engine.ts) measured against it
 * and never fired again, and the Subscriptions module said "Next on" about a
 * day already gone. Projected onto the cadence the stored date is the
 * series' anchor — the 14th stays the 14th — which is how the forecast
 * (lib/finance/timeline.ts) has always walked it.
 */
export function projectedNextCharge(nextCharge: string | null | undefined, cadence: string | null | undefined, today: string): string | null {
  if (!nextCharge) return null;
  return nextOccurrenceOnOrAfter(nextCharge.slice(0, 10), subscriptionCadence(cadence), today);
}

export const DUE_META: Record<DueStatus, { label: string; tint: string }> = {
  paid: { label: 'Paid', tint: 'bg-emerald-500/15 text-emerald-300' },
  overdue: { label: 'Overdue', tint: 'bg-rose-500/15 text-rose-300' },
  due_soon: { label: 'Due soon', tint: 'bg-amber-500/15 text-amber-300' },
  upcoming: { label: 'Upcoming', tint: 'bg-blue-500/15 text-blue-300' },
};

export type Period = 'weekly' | 'monthly' | 'yearly';

/**
 * ISO date (YYYY-MM-DD) for the start of the current budget period, on the
 * READER's calendar. `d` is built from local parts, so it must be read back out
 * with local parts too: `toISOString()` re-expresses that local midnight at
 * Greenwich, which east of Greenwich is the previous day (1 June 00:00 in Tokyo
 * is 31 May 15:00Z). The key is compared against `transactions.date`, a DATE
 * column that is already a calendar day, so a key one day early silently pulls
 * the last day of the previous period into this period's spend.
 */
export function periodStart(period: Period, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'weekly') { d.setDate(d.getDate() - d.getDay()); }
  else if (period === 'monthly') { d.setDate(1); }
  else { d.setMonth(0, 1); }
  return localDayKey(d);
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

export function fmtDueDate(iso: string, locale: LocaleCode = DEFAULT_LOCALE): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}
