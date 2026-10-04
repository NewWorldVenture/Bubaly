// lib/finance/recurring.ts — pure, tested helpers for a recurring bill: its
// cadence, its next due date, and what "Mark paid" writes.
//
// Day keys in, day keys out, stepped on UTC fields only, so nothing here reads
// the calendar of the machine it runs on. That is why this is not in
// lib/finance/hub.ts: the forecast loader (lib/finance/timeline-load.ts) runs
// on the server, and hub.ts's due-status helpers read local calendar fields,
// which are the family's day only in the family's browser
// (tests/a-server-path-does-not-read-the-hosts-calendar.test.ts).

import { isMissingRelationError } from '@/lib/supabase/errors';

// ── Recurring bills ──────────────────────────────────────────────────────────

export type BillCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

const CADENCES: Record<string, BillCadence> = {
  weekly: 'weekly', biweekly: 'biweekly', fortnightly: 'biweekly',
  monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly', annually: 'yearly',
};

export interface RecurringBillLike {
  due_date: string;
  status: string;
  is_recurring?: boolean | null;
  recurrence?: string | null;
  /** The day of month a month-based series is anchored on (0475); null reads it from `due_date`. */
  due_day?: number | null;
}

/** The cadences that step by months, and so can lose their day to a short month. */
export const MONTH_BASED_CADENCES: ReadonlySet<BillCadence> = new Set<BillCadence>(['monthly', 'quarterly', 'yearly']);

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

const isAnchorDay = (day: unknown): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 31;

/**
 * The day of month a bill's month-based series is anchored on: the recorded
 * `due_day` (0475), else the day of `due_date`. Null when neither is a day.
 */
export function billAnchorDay(bill: Pick<RecurringBillLike, 'due_date' | 'due_day'>): number | null {
  if (isAnchorDay(bill.due_day)) return bill.due_day;
  return parseDayKey(bill.due_date)?.[2] ?? null;
}

/** The `due_day` a NEW bill is written with: the day of its due date for a month-based recurring bill, else null. */
export function newBillDueDay(dueDate: string, isRecurring: boolean, recurrence: string | null | undefined): number | null {
  if (!isRecurring) return null;
  const cadence = billCadence({ is_recurring: true, recurrence });
  return cadence && MONTH_BASED_CADENCES.has(cadence) ? parseDayKey(dueDate)?.[2] ?? null : null;
}

/**
 * The anchor stepped `n` periods on. A month step keeps the series' day of
 * month (`day`, the anchor day; the date's own day when none is recorded) and
 * clamps to a shorter month, so a bill due on the 31st falls on Feb 28 and is
 * back on Mar 31. A week step counts days from the date itself.
 */
function stepFrom([y, mo, d]: [number, number, number], cadence: BillCadence, n: number, day = d): string {
  if (cadence === 'weekly' || cadence === 'biweekly') return dayKeyOf(Date.UTC(y, mo, d + n * (cadence === 'weekly' ? 7 : 14)));
  const months = n * (cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12);
  const lastDay = new Date(Date.UTC(y, mo + months + 1, 0)).getUTCDate();
  return dayKeyOf(Date.UTC(y, mo + months, Math.min(day, lastDay)));
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
 *
 * `anchorDay` is the day the month-based series is anchored on (0475's
 * `due_day`). `dueDate` is the PERSISTED date, and after one roll that is the
 * clamped one: a bill due on the 31st sits on Feb 28, and stepped from that
 * date's own day it would come back on the 28th for ever — the month-end
 * cadence lost (audit note of 2026-10-04 07:45 UTC). Stepped by the anchor
 * day it is back on Mar 31. Without an anchor day the date's own day is used,
 * which is what every row written before 0475 has.
 */
export function nextBillDueDate(dueDate: string, cadence: BillCadence, today: string, anchorDay?: number | null): string | null {
  const anchor = parseDayKey(dueDate);
  if (!anchor) return null;
  const day = isAnchorDay(anchorDay) ? anchorDay : anchor[2];
  const due = dueDate.slice(0, 10);
  const floor = parseDayKey(today) && today.slice(0, 10) > due ? today.slice(0, 10) : due;
  // Day keys compare as text. 5000 weekly steps is close to a century.
  for (let n = 1; n <= 5000; n += 1) {
    const next = stepFrom(anchor, cadence, n, day);
    if (next > floor) return next;
  }
  return null;
}

export type BillPaidPatch = { status: 'paid' } | { status: 'upcoming'; due_date: string; due_day?: number };

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
 *
 * A month-based bill also writes its anchor day (`due_day`, 0475): the day it
 * is stepped by, recorded the first time it rolls so the day survives the
 * clamp to a short month. A row from before 0475 records the day of its
 * current due date, which is all it knows.
 */
export function billPaidPatch(bill: RecurringBillLike, today: string): BillPaidPatch {
  const cadence = billCadence(bill);
  if (!cadence) return { status: 'paid' };
  const anchorDay = MONTH_BASED_CADENCES.has(cadence) ? billAnchorDay(bill) : null;
  const next = nextBillDueDate(bill.due_date, cadence, today, anchorDay);
  if (!next) return { status: 'paid' };
  return anchorDay !== null ? { status: 'upcoming', due_date: next, due_day: anchorDay } : { status: 'upcoming', due_date: next };
}

/** PostgREST (PGRST204) or Postgres (42703) refusing `bills.due_day` on a database that has not applied 0475. */
export function isMissingDueDayColumn(error: unknown): boolean {
  const message = typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  return isMissingRelationError(error) && /due_day/i.test(message);
}

/**
 * Runs `write(patch)`; on a database without `bills.due_day` runs it once more
 * without that column, with a warning naming the migration — so a deploy
 * ahead of 0475 pays and adds bills exactly as before. What that database
 * CANNOT do is keep a month-end bill's day: rolled from Jan 31 it lands on
 * Feb 28 with nowhere to record the 31, so it steps from the 28th thereafter
 * and, once 0475 arrives, records 28 as its anchor (`billAnchorDay` reads the
 * due date's day when `due_day` is null; the migration has no backfill). That
 * loss is stated here and in the warning rather than papered over: the one
 * way to keep the day is to apply 0475 before the first roll (review
 * 5981566086 on #932). Any other refusal is returned as it came.
 */
export async function writeBillPatch<P extends object, W extends (p: P) => PromiseLike<{ error: unknown }>>(
  patch: P,
  write: W,
): Promise<Awaited<ReturnType<W>>> {
  const first = (await write(patch)) as Awaited<ReturnType<W>>;
  if (!first.error || !('due_day' in patch) || !isMissingDueDayColumn(first.error)) return first;
  console.warn('bills.due_day is not in this database yet (migration 0475_a_month_end_bill_keeps_its_day has not been applied); writing without it. A month-end bill rolled on this database LOSES its original day: it steps from its clamped date, and once the column arrives it records that date\'s day, not the day it was created on. 0475 has no backfill that could recover it.');
  const rest = { ...patch } as Record<string, unknown>;
  delete rest.due_day;
  // The same row without the one column this database lacks.
  return (await write(rest as P)) as Awaited<ReturnType<W>>;
}
