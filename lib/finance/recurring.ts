// lib/finance/recurring.ts — pure, tested helpers for a series that repeats:
// a recurring bill's cadence, its next due date and what "Mark paid" writes,
// and where a subscription's next charge falls.
//
// Day keys in, day keys out, stepped on UTC fields only, so nothing here reads
// the calendar of the machine it runs on. That is why this is not in
// lib/finance/hub.ts: the forecast loader (lib/finance/timeline-load.ts) and
// the autopilot engine (lib/autopilot/engine.ts) run on the server, and
// hub.ts's due-status helpers read local calendar fields, which are the
// family's day only in the family's browser
// (tests/a-server-path-does-not-read-the-hosts-calendar.test.ts).

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
 * The cadence a bill repeats on, or null for a one-off. Mark paid and the
 * forecast (lib/finance/timeline.ts) both read it, so the date a payment rolls
 * a bill to is the next date the forecast shows for it.
 *
 * A bill repeats when it is flagged `is_recurring`; both add forms write a
 * cadence only for a flagged bill, so an unflagged one is a one-off whatever
 * its `recurrence` says. A flagged bill with NO cadence is what the Bill
 * Manager's add form wrote until it gained a cadence field (the Billing
 * module's form always recorded one), and one with a name that is not a
 * cadence came from neither form. Both are read as monthly — the cadence that
 * form now defaults to, and the one nearly every household bill is on —
 * rather than as a one-off that a payment closes and the forecast shows once.
 */
export function billCadence(bill: Pick<RecurringBillLike, 'is_recurring' | 'recurrence'>): BillCadence | null {
  if (!bill.is_recurring) return null;
  return namedCadence(bill.recurrence) ?? 'monthly';
}

/**
 * A stored cadence name, read the way a person would: case and surrounding
 * space ignored. Only the table's own names count: `recurrence` is free text,
 * and a plain lookup also answers for `constructor`, `toString` and the rest
 * of Object.prototype (a function, not a cadence). Null when it names none.
 */
export function namedCadence(name: string | null | undefined): BillCadence | null {
  const key = name?.trim().toLowerCase() ?? '';
  return Object.hasOwn(CADENCES, key) ? CADENCES[key] : null;
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
  return firstStepAfter(anchor, cadence, floor, day, false);
}

/**
 * The first occurrence of the series anchored at `anchor`, one step or more
 * from it, that falls after `floor` (or on it, when `onFloor`). It starts at
 * the last step that cannot be past the floor rather than walking from the
 * anchor, so a series whose date went stale decades ago is caught up in a
 * step or two: a walk with a cap left a weekly bill a century stale with no
 * next date, and Mark paid then closed it for good.
 */
function firstStepAfter(anchor: [number, number, number], cadence: BillCadence, floor: string, day: number, onFloor: boolean): string | null {
  const end = parseDayKey(floor);
  if (!end) return null;
  let start: number;
  if (cadence === 'weekly' || cadence === 'biweekly') {
    // Occurrence n is n periods of days on: below floor(days / period) it is
    // before the floor.
    const days = Math.round((Date.UTC(...end) - Date.UTC(...anchor)) / 86_400_000);
    start = Math.floor(days / (cadence === 'weekly' ? 7 : 14));
  } else {
    // Occurrence n falls in the month n periods on: below floor(months /
    // period) that month is before the floor's.
    const months = (end[0] - anchor[0]) * 12 + (end[1] - anchor[1]);
    start = Math.floor(months / (cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12));
  }
  // From there the floor is passed within two steps; three is a margin.
  for (let n = Math.max(1, start); n <= Math.max(1, start) + 3; n += 1) {
    const next = stepFrom(anchor, cadence, n, day);
    if (onFloor ? next >= floor : next > floor) return next;
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

/** What `whereBillIsAsSeen` needs of a query builder: PostgREST's generic `filter`. */
interface BillFilterable { filter(column: string, operator: string, value: unknown): this }

/**
 * Narrows a Mark paid write to the bill exactly as the button saw it: the due
 * date and status (two clicks on one stale row would otherwise roll it twice
 * and skip an occurrence), and everything the patch was stepped by — the
 * cadence (`is_recurring`, `recurrence`) and the anchor day (`due_day`). A
 * bill edited under the button matches no row, writes nothing, and the button
 * says the change was not saved.
 *
 * `due_day` is compared only when the row was read with it. A database
 * without 0475 has no such column to filter on, and its rows come back
 * without the key; a row read with it carries a number or null. Both Mark
 * paid buttons and the tests write through this one function.
 */
export function whereBillIsAsSeen<Q extends BillFilterable>(
  query: Q,
  seen: Pick<RecurringBillLike, 'due_date' | 'status' | 'is_recurring' | 'recurrence' | 'due_day'>,
): Q {
  const same = (q: Q, column: string, value: unknown) => q.filter(column, value === null || value === undefined ? 'is' : 'eq', value ?? null);
  let q = same(same(same(same(query, 'due_date', seen.due_date), 'status', seen.status), 'is_recurring', seen.is_recurring), 'recurrence', seen.recurrence);
  if (seen.due_day !== undefined) q = same(q, 'due_day', seen.due_day);
  return q;
}

/**
 * PostgREST (PGRST204) or Postgres (42703) refusing `bills.due_day` itself on
 * a database that has not applied 0475 — and nothing else. Only those two
 * codes say a COLUMN is missing, and the message must name exactly that column
 * of `bills`: not `due_day_backup`, not a missing `due_day_history` table, not
 * a permission error that happens to mention the schema cache. Anything else
 * is returned as it came; the retry without the column is for this one case.
 */
export function isMissingDueDayColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== 'PGRST204' && code !== '42703') return false;
  const text = typeof message === 'string' ? message : '';
  return /'due_day'|"due_day"|\bbills\.due_day\b/i.test(text) && /\bbills\b/i.test(text);
}

/**
 * What `writeBillPatch` answers, instead of writing, when a bill's day of
 * month could be kept only in `bills.due_day` and the database has no such
 * column yet (0475 not applied). Not a database error: nothing was sent.
 */
export const DUE_DAY_NOT_KEPT = 'BUBALY_DUE_DAY_NOT_KEPT';

export interface DueDayNotKept {
  code: typeof DUE_DAY_NOT_KEPT;
  message: string;
  /** The day of month the bill is anchored on: the day a short month would lose. */
  day: number;
  /** Where the bill would have rolled to, clamped to that month's last day. */
  dueDate: string | null;
}

export function isDueDayNotKept(error: unknown): error is DueDayNotKept {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DUE_DAY_NOT_KEPT;
}

/**
 * The anchor day a patch records that its own due date does not already say,
 * or null when leaving `due_day` out loses nothing: there is none, or the due
 * date falls on that very day (every new bill; every roll into a month long
 * enough for its day). Non-null exactly when the roll was CLAMPED: a 31st
 * bill landing on Feb 28 or Apr 30, a 29th or 30th bill on Feb 28, a 29 Feb
 * yearly bill on 28 Feb of a common year.
 */
function dayOnlyDueDayCarries(patch: object): number | null {
  const { due_day: day, due_date: date } = patch as { due_day?: unknown; due_date?: unknown };
  if (day === null || day === undefined) return null;
  const onDate = typeof date === 'string' ? parseDayKey(date)?.[2] ?? null : null;
  if (onDate !== null && onDate === day) return null;
  return isAnchorDay(day) ? day : null;
}

export interface WriteBillPatchOptions {
  /**
   * Asks the person whether to move the bill to the clamped date and keep
   * that day from then on. Called only when the roll would be clamped AND the
   * database cannot record the original day; resolves true to proceed. Only a
   * button a person is looking at passes it: without it (a server path, an AI
   * tool, the autopilot) the roll is refused, never clamped.
   */
  confirmClampedDay?: (refusal: DueDayNotKept) => Promise<boolean>;
}

/**
 * Runs `write(patch)`. On a database without `bills.due_day` (PGRST204 /
 * 42703: 0475 not applied, which is production for now) it does one of three
 * things, and never silently loses a bill's day:
 *
 * - When the due date already carries the day (`dayOnlyDueDayCarries` is
 *   null) it writes once more without the column. Nothing is lost: on that
 *   database `billAnchorDay` reads the day from `due_date`, and it is the
 *   same day. A new bill, a weekly bill, a bill on the 15th, and a 31st bill
 *   rolling into March all go this way, so every other bill rolls exactly as
 *   it would with 0475.
 * - When only the column could carry it (a 31st bill rolling to Feb 28) and
 *   the caller can ask (`confirmClampedDay`), the person is asked whether to
 *   mark it paid and move it to Feb 28, due on the 28th from then on. Yes:
 *   it is written on that date without the column, through the same `write`,
 *   so the caller's compare-and-set still decides; a bill that moved while
 *   the question was open matches no row. The person chose the new day, so
 *   nothing was lost behind their back.
 * - Otherwise (they said no, or there is no one to ask) it writes NOTHING and
 *   answers `DueDayNotKept`. Both Mark paid buttons then tell the person, in
 *   their language, that the bill's day cannot be kept until the database
 *   update is applied and that the bill was left as it was.
 *
 * Why not simply roll. The roll would store Feb 28, and a 0176-era `bills`
 * row (id, family_id, name, amount, due_date, is_recurring, recurrence,
 * status, category, autopay, created_by, created_at, updated_at) has nowhere
 * else to hold the 31: at Feb 28 it cannot tell a 28th bill from a clamped
 * 31st, it would step to Mar 28 for ever, and 0475 could not recover the day
 * afterwards. The alternatives were weighed:
 *   (a) Carrying the day in an existing column. `recurrence` is the only free
 *       text that is not the person's own words (`name`, `category`), but it
 *       is not read through one parser: the Billing module prints it to the
 *       person as stored, and the forecast matches it by exact name
 *       (lib/finance/timeline.ts, where an unknown cadence is a one-off and
 *       costs nothing a month), as does any client already deployed. An
 *       encoding such as 'monthly@31' would show on screen and drop the bill
 *       out of the forecast. `status` is an enum; `amount`, `due_date` and
 *       the stamps mean what they say.
 *   (b) Another durable signal without a migration. None exists: nothing
 *       records the series' first date, Mark paid keeps no payment history,
 *       and keeping the day in another table would be a second, non-atomic
 *       write under different row-level security that every reader of
 *       `bills` would have to join, and could itself be lost.
 *   (c) Failing closed for exactly the case at risk. It is narrow (a bill on
 *       the 29th, 30th or 31st rolling into a shorter month) and loses
 *       nothing, but alone it would leave a 31st bill impossible to mark paid
 *       in five months of every twelve until 0475 is applied.
 * So (c), with the one way past it in the person's hands: they may choose
 * the shorter day, knowingly, and nobody chooses it for them.
 *
 * Any other refusal is returned as it came, and a patch that never carried
 * the column is never retried.
 */
export async function writeBillPatch<P extends object, W extends (p: P) => PromiseLike<{ error: unknown }>>(
  patch: P,
  write: W,
  options: WriteBillPatchOptions = {},
): Promise<Awaited<ReturnType<W>> | { data: null; error: DueDayNotKept }> {
  const first = (await write(patch)) as Awaited<ReturnType<W>>;
  if (!first.error || !('due_day' in patch) || !isMissingDueDayColumn(first.error)) return first;
  // The same row without the one column this database lacks.
  const rest = { ...patch } as Record<string, unknown>;
  delete rest.due_day;
  const unkept = dayOnlyDueDayCarries(patch);
  if (unkept !== null) {
    const rolledTo = (patch as { due_date?: unknown }).due_date;
    const dueDate = typeof rolledTo === 'string' ? rolledTo : null;
    const message = `bills.due_day is not in this database yet (migration 0475_a_month_end_bill_keeps_its_day has not been applied). This bill is anchored on day ${unkept} and would roll to ${dueDate ?? 'a shorter month'}, where only that column could keep the day, so nothing was written. Apply 0475 and the bill rolls with its day kept.`;
    const refusal: DueDayNotKept = { code: DUE_DAY_NOT_KEPT, message, day: unkept, dueDate };
    if (dueDate && options.confirmClampedDay && (await options.confirmClampedDay(refusal))) {
      console.warn(`bills.due_day is not in this database yet (migration 0475_a_month_end_bill_keeps_its_day has not been applied). The person chose to mark this bill paid and move it from day ${unkept} to ${dueDate}, keeping that date's day from now on; writing without the column.`);
      return (await write(rest as P)) as Awaited<ReturnType<W>>;
    }
    console.warn(message);
    return { data: null, error: refusal };
  }
  console.warn('bills.due_day is not in this database yet (migration 0475_a_month_end_bill_keeps_its_day has not been applied); writing without it. This due date falls on the bill\'s own day, so the date alone carries it and nothing is lost.');
  return (await write(rest as P)) as Awaited<ReturnType<W>>;
}

/** What the Mark paid buttons ask through the shared confirm dialog (components/ui/confirm.tsx). */
export interface DueDayQuestion {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Moving a bill is not a delete: the proceed button is not painted red. */
  destructive: false;
}

/**
 * The question for a `DueDayNotKept` refusal: mark it paid and move it to the
 * clamped date, due on that date's day from then on? `formatDay` renders a
 * day key the way the asking module renders its due dates; `locale` names the
 * short month in the reader's language (a calendar month of a day key, so no
 * zone is involved).
 */
export function dueDayNotKeptQuestion(
  refusal: DueDayNotKept,
  t: (key: string, params?: Record<string, string | number>) => string,
  formatDay: (dayKey: string) => string,
  locale: string,
): DueDayQuestion {
  const target = refusal.dueDate ? parseDayKey(refusal.dueDate) : null;
  const month = target
    ? new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(target[0], target[1], 1)))
    : '';
  return {
    title: t('bills.moveToShorterMonthTitle', { date: refusal.dueDate ? formatDay(refusal.dueDate) : '' }),
    body: t('bills.moveToShorterMonthBody', { day: refusal.day, month, newDay: target?.[2] ?? refusal.day }),
    confirmLabel: t('bills.moveToShorterMonthConfirm'),
    cancelLabel: t('bills.moveToShorterMonthCancel'),
    destructive: false,
  };
}

// ── Subscriptions ───────────────────────────────────────────────────────────

/** The cadence a subscription is billed on: the module's four plus the forecast's aliases; anything else reads as monthly, as the forecast does. */
export function subscriptionCadence(cadence: string | null | undefined): BillCadence {
  return namedCadence(cadence) ?? 'monthly';
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
  return firstStepAfter(start, cadence, floor, start[2], true);
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
