// Pure calendar-date scheduling shared by client and server finance paths.
// Row shape stays independent of the browser's display/calendar helpers.

export type BillCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
export const BILL_CADENCES: readonly BillCadence[] = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
export const MONTH_BASED_CADENCES: ReadonlySet<BillCadence> = new Set(['monthly', 'quarterly', 'yearly']);
const CADENCES: Record<string, BillCadence> = {
  weekly: 'weekly', biweekly: 'biweekly', fortnightly: 'biweekly', monthly: 'monthly',
  quarterly: 'quarterly', yearly: 'yearly', annually: 'yearly',
};
export interface RecurringBillLike {
  due_date: string;
  status: string;
  is_recurring: boolean;
  recurrence: string | null;
  due_day?: number | null;
}

/** Missing/unknown cadence is unknown; a payment must never invent one. */
export function billCadence(bill: Pick<RecurringBillLike, 'is_recurring' | 'recurrence'>): BillCadence | null {
  const name = bill.recurrence?.trim().toLowerCase() ?? '';
  return bill.is_recurring && Object.hasOwn(CADENCES, name) ? CADENCES[name] : null;
}

function parseBillDay(key: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo && probe.getUTCDate() === d ? [y, mo, d] : null;
}
export const isBillAnchorDay = (day: unknown): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 31;

/** Days 28–30 may already have drifted after an earlier short-month clamp. */
export function billAnchorDay(bill: Pick<RecurringBillLike, 'due_date' | 'due_day'>): number | null {
  if (bill.due_day != null) return isBillAnchorDay(bill.due_day) ? bill.due_day : null;
  const parts = parseBillDay(bill.due_date);
  if (!parts) return null;
  const day = parts[2];
  // March 28 can already be Jan 31 -> Feb 28 -> Mar 28 on an old schema.
  // Neither the current month nor applying the new column recovers that day.
  return day >= 28 && day <= 30 ? null : day;
}

/** The owner chooses a new bill's first date, so its day is an explicit anchor. */
export function newBillDueDay(dueDate: string, isRecurring: boolean, recurrence: string | null): number | null {
  const cadence = billCadence({ is_recurring: isRecurring, recurrence });
  return cadence && MONTH_BASED_CADENCES.has(cadence) ? parseBillDay(dueDate)?.[2] ?? null : null;
}

/** Keep an explicitly selected day and its first due date consistent. */
export function billDateForAnchorDay(dueDate: string, day: number): string | null {
  const parts = parseBillDay(dueDate);
  if (!parts || !isBillAnchorDay(day)) return null;
  const [year, month] = parts;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last))).toISOString().slice(0, 10);
}

/** Step from one fixed anchor; February's clamp never becomes March's anchor. */
export function nextBillDueDate(dueDate: string, cadence: BillCadence, today: string, anchorDay?: number | null): string | null {
  const anchor = parseBillDay(dueDate), current = parseBillDay(today);
  if (!anchor || !current || (anchorDay != null && !isBillAnchorDay(anchorDay))) return null;
  const [year, month, day] = anchor;
  const floor = today > dueDate ? today : dueDate;
  const monthStep = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12;
  const monthBased = MONTH_BASED_CADENCES.has(cadence);
  let step = monthBased ? Math.max(1, Math.floor(((current[0] - year) * 12 + current[1] - month) / monthStep))
    : Math.max(1, Math.floor((Date.UTC(...current) - Date.UTC(...anchor)) / (86400000 * (cadence === 'weekly' ? 7 : 14))));
  for (let attempts = 0; attempts < 3; attempts++, step++) {
    const last = new Date(Date.UTC(year, month + step * monthStep + 1, 0)).getUTCDate();
    const next = new Date(monthBased
      ? Date.UTC(year, month + step * monthStep, Math.min(anchorDay ?? day, last))
      : Date.UTC(year, month, day + step * (cadence === 'weekly' ? 7 : 14))).toISOString().slice(0, 10);
    if (next > floor) return next;
  }
  return null;
}

export type BillScheduleChoice = { cadence: BillCadence; dueDay?: number };
export type BillPaidPatch = { status: 'paid' } | { status: 'upcoming'; due_date: string; recurrence: BillCadence; due_day?: number };

/** Null means the owner must confirm an unknown cadence/anchor before paying. */
export function billPaidPatch(bill: RecurringBillLike, today: string, choice?: BillScheduleChoice): BillPaidPatch | null {
  if (!bill.is_recurring) return { status: 'paid' };
  const cadence = choice?.cadence ?? billCadence(bill);
  if (!cadence || !BILL_CADENCES.includes(cadence)) return null;
  const monthBased = MONTH_BASED_CADENCES.has(cadence);
  const day = monthBased ? choice?.dueDay ?? billAnchorDay(bill) : null;
  if (monthBased && !isBillAnchorDay(day)) return null;
  const next = nextBillDueDate(bill.due_date, cadence, today, day);
  if (!next) return null;
  return { status: 'upcoming', due_date: next, recurrence: cadence, ...(day !== null ? { due_day: day } : {}) };
}
