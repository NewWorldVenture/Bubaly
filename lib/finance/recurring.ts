// 0488_a_month_end_bill_keeps_its_day, reserved and held in supabase/reserved.
// Its absent column allows only writes that retain a proven original anchor.
// Calendar scheduling is shared by payment, forecast and subscription readers.
export * from './bill-schedule';
import type { BillCadence, RecurringBillLike } from './bill-schedule';

const CADENCES: Record<string, BillCadence> = {
  weekly: 'weekly',
  biweekly: 'biweekly',
  fortnightly: 'biweekly',
  monthly: 'monthly',
  quarterly: 'quarterly',
  yearly: 'yearly',
  annually: 'yearly',
};
export function namedCadence(name: string | null | undefined): BillCadence | null {
  const key = name?.trim().toLowerCase() ?? '';
  return Object.hasOwn(CADENCES, key) ? CADENCES[key] : null;
}
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})/;
function parseDayKey(key: string): [number, number, number] | null {
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const y = Number(m[1]),
    mo = Number(m[2]) - 1,
    d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo || probe.getUTCDate() !== d) return null;
  return [y, mo, d];
}
const dayKeyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function stepFrom([y, mo, d]: [number, number, number], cadence: BillCadence, n: number, day = d): string {
  if (cadence === 'weekly' || cadence === 'biweekly')
    return dayKeyOf(Date.UTC(y, mo, d + n * (cadence === 'weekly' ? 7 : 14)));
  const months = n * (cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12);
  const lastDay = new Date(Date.UTC(y, mo + months + 1, 0)).getUTCDate();
  return dayKeyOf(Date.UTC(y, mo + months, Math.min(day, lastDay)));
}
function firstStepAfter(
  anchor: [number, number, number],
  cadence: BillCadence,
  floor: string,
  day: number,
  onFloor: boolean,
): string | null {
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

interface BillFilterable {
  filter(column: string, operator: string, value: unknown): this;
}
/** Match the exact snapshot; the stamp also rejects edits and schedule ABA. */
export function whereBillIsAsSeen<Q extends BillFilterable>(
  query: Q,
  seen: Pick<RecurringBillLike, 'due_date' | 'status' | 'is_recurring' | 'recurrence' | 'due_day'> & {
    updated_at: string;
  },
): Q {
  const same = (column: string, value: unknown) => {
    query = query.filter(column, value == null ? 'is' : 'eq', value ?? null);
  };
  same('updated_at', seen.updated_at);
  same('due_date', seen.due_date);
  same('status', seen.status);
  same('is_recurring', seen.is_recurring);
  same('recurrence', seen.recurrence);
  if (seen.due_day !== undefined) same('due_day', seen.due_day);
  return query;
}
export function isMissingDueDayColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== 'PGRST204' && code !== '42703') return false;
  const text = typeof message === 'string' ? message : '';
  return /'due_day'|"due_day"|\bbills\.due_day\b/i.test(text) && /\bbills\b/i.test(text);
}

export const DUE_DAY_NOT_KEPT = 'BUBALY_DUE_DAY_NOT_KEPT';
export interface DueDayNotKept {
  code: typeof DUE_DAY_NOT_KEPT;
  message: string;
  day: number;
  dueDate: string | null;
}
export function isDueDayNotKept(error: unknown): error is DueDayNotKept {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DUE_DAY_NOT_KEPT
  );
}

/** Retry only when the date alone proves the same original anchor on reread. */
export async function writeBillPatch<P extends object, W extends (p: P) => PromiseLike<{ error: unknown }>>(
  patch: P | null,
  write: W,
): Promise<Awaited<ReturnType<W>> | { data: null; error: Error | DueDayNotKept }> {
  if (!patch) return { data: null, error: new Error('Confirm the recurring bill schedule before saving.') };
  const first = (await write(patch)) as Awaited<ReturnType<W>>;
  if (!first.error || !('due_day' in patch) || !isMissingDueDayColumn(first.error)) return first;
  const { due_day: day, due_date: date } = patch as { due_day?: number | null; due_date?: string };
  const onDate = typeof date === 'string' ? parseDayKey(date)?.[2] : undefined;
  // A day 28–30 without its column is historically ambiguous. A clamp also
  // loses the original day. Neither may be reinterpreted as a new schedule.
  if (day != null && (onDate !== day || (day >= 28 && day <= 30))) {
    return {
      data: null,
      error: {
        code: DUE_DAY_NOT_KEPT,
        message:
          'The bill anchor cannot be kept until reserved migration 0488 is applied. Nothing was saved.',
        day,
        dueDate: date ?? null,
      },
    };
  }
  const rest = { ...patch };
  delete (rest as { due_day?: unknown }).due_day;
  return (await write(rest)) as Awaited<ReturnType<W>>;
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
export function projectedNextCharge(
  nextCharge: string | null | undefined,
  cadence: string | null | undefined,
  today: string,
): string | null {
  if (!nextCharge) return null;
  return nextOccurrenceOnOrAfter(nextCharge.slice(0, 10), subscriptionCadence(cadence), today);
}
