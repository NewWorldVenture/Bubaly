// lib/briefing/kitchen-agenda.ts — what the kitchen display says about today.
//
// The kitchen view (components/modules/briefing-module.tsx) lists what is
// coming up today and says, for each member, what they are doing now or next.
// It read every row as an instant: today was the rows whose instant fell on the
// family's day, "coming up" was every row starting after now, and a member's
// next thing was their first row after now, at its clock time.
//
// An all-day row is a DATE stored as an instant on that date in UTC
// (lib/calendar/day.ts), and none of that holds for it. In Los Angeles today's
// all-day row (today 00:00Z) is yesterday afternoon, so it was not on today's
// list at all and yesterday's was; in Tokyo it is 09:00, so before nine the
// kitchen announced "Next: School closed at 9:00 AM". An all-day row is on its
// own date, is never "next at" a time, says "all day", and heads the list.
import { addDays, familyFetchRange } from '@/lib/calendar/day';
import { projectCalendarDay, type CalendarConsumerEvent } from '@/lib/calendar/consumer-spans';

export type KitchenEvent = CalendarConsumerEvent;

/** How long a timed row without an end is taken to last, for "what is on now". */
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

/**
 * The instants the kitchen's read spans: every row ON the family's today —
 * timed rows from the family's midnight to the next, all-day rows dated today
 * (familyFetchRange). `to` is the last millisecond of the span, for a read that
 * bounds it with `lte`.
 */
export function kitchenFetchWindow(todayKey: string, timezone: string): { from: string; to: string } {
  const range = familyFetchRange(todayKey, addDays(todayKey, 1), timezone);
  return { from: range.from.toISOString(), to: new Date(range.to.getTime() - 1).toISOString() };
}

/** Today's rows, in the order the kitchen reads them: all-day rows first, then by start. */
export function kitchenToday<T extends KitchenEvent>(rows: readonly T[], todayKey: string, timezone: string) {
  return projectCalendarDay(rows,todayKey,timezone);
}

/**
 * "Coming up today": today's all-day rows (they are on all day, so never behind
 * us), then the timed rows still to start; at most `limit`.
 */
export function kitchenUpcoming<T extends KitchenEvent>(today: readonly T[], now: Date, limit = 5): T[] {
  const allDay = today.filter((e) => e.all_day);
  const timed = today.filter((e) => !e.all_day && Date.parse(e.starts_at) > now.getTime());
  return [...allDay, ...timed].slice(0, limit);
}

export type KitchenStatus =
  | { kind: 'now'; title: string }
  | { kind: 'allDay'; title: string }
  | { kind: 'next'; title: string; startsAt: string }
  | { kind: 'free' };

/**
 * What one member is doing: a timed row under way now; else an all-day row of
 * theirs today (on all day, never "next at" its stored instant); else their
 * next timed row today; else free.
 */
export function kitchenMemberStatus(today: readonly KitchenEvent[], memberId: string, now: Date): KitchenStatus {
  const at = now.getTime();
  const theirs = today.filter((e) => e.assignee_id === memberId);
  const timed = theirs.filter((e) => !e.all_day);
  const current = timed.find((e) => {
    const start = Date.parse(e.starts_at);
    const parsedEnd = e.ends_at ? Date.parse(e.ends_at) : Number.NaN;
    const end = Number.isFinite(parsedEnd) ? parsedEnd : start + DEFAULT_DURATION_MS;
    return start <= at && end > at;
  });
  if (current) return { kind: 'now', title: current.title??'' };
  const allDay = theirs.find((e) => e.all_day);
  if (allDay) return { kind: 'allDay', title: allDay.title??'' };
  const next = timed.find((e) => Date.parse(e.starts_at) > at);
  if (next) return { kind: 'next', title: next.title??'', startsAt: next.starts_at };
  return { kind: 'free' };
}
