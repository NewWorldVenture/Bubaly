import { parseExactInstant, formatExactInstant, exactInstantMilliseconds, compareExactInstants } from './exact-instant';
// lib/calendar/recurrence.ts — pure, unit-tested recurring-event expansion.
//
// calendar_events stores a recurrence rule ('none'|'daily'|'weekly'|'monthly'|
// 'yearly' + optional recurrence_until), but until this module NOTHING expanded
// it: a weekly event rendered once on its start date and vanished from every
// later week. This expands recurring events into concrete occurrences inside a
// view window, DB-free, so any view (month/week/day/agenda) can treat the
// result as plain events. Occurrences keep the source row's id (so the detail
// modal/RSVPs work) with shifted starts_at/ends_at; render keys should
// therefore combine id + starts_at.
//
// The stepping happens on the WALL CLOCK of a named zone, not on a Date's
// runtime-local getters. In a browser those are the same thing, which is why
// the first version was right where it ran and wrong the moment a server asked
// the same question: on a server, runtime-local is UTC, so a weekly 4pm New
// York event stepped by exactly 7×24h and became 3pm the week the clocks
// changed — and a late-evening one crossed into the neighbouring local day,
// where a "what's on today" query then missed it entirely.
import {
  daysInMonth, instantForIcsLocalTime, localPartsAt, type LocalParts,
} from '@/lib/time/zoned';
import { familyFetchRange } from '@/lib/calendar/day';

export interface RecurrableEvent {
  id: string;
  starts_at: string;
  ends_at: string | null;
  recurrence: string;
  recurrence_until?: string | null;
}

/** Hard cap on occurrences generated per event PER WINDOW (a daily event over a
 *  6-week month grid is ~42; 500 protects against pathological windows). */
const MAX_OCCURRENCES = 500;

const DAY_MS = 86_400_000;
function calendarDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  // Date.UTC remaps years00–99 into1900–1999; setUTCFullYear does not.
  date.setUTCFullYear(year, month - 1, day);
  return date;
}
const dayNumber = (year: number, month: number, day: number) =>
  Math.floor(calendarDate(year, month, day).getTime() / DAY_MS);

/**
 * The local date of the n-th occurrence.
 *
 * `undefined` means the frequency is not one we know and the series should
 * stop. `null` means this step landed on a day-of-month that does not exist —
 * the 31st in a 30-day month, or the 29th of February in a common year — and
 * must be SKIPPED rather than slid forward, so "the 31st, monthly" does not
 * quietly become "the 1st" and then drift.
 *
 * Computed from the base date every time. A mutating cursor drifts permanently
 * once a month rolls: Jan 31 +1mo → Mar 3, and every later step then runs from
 * the 3rd.
 */
function steppedLocalDate(
  base: LocalParts, freq: string, n: number,
): { year: number; month: number; day: number } | null | undefined {
  switch (freq) {
    case 'daily':
    case 'weekly': {
      // Pure calendar arithmetic in UTC — no zone and no DST is involved in
      // "the date seven days after this one".
      const shifted = calendarDate(base.year, base.month, base.day + (freq === 'daily' ? n : n * 7));
      return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
    }
    case 'monthly': {
      const total = base.year * 12 + (base.month - 1) + n;
      const year = Math.floor(total / 12);
      const month = (total % 12) + 1;
      return base.day > daysInMonth(year, month) ? null : { year, month, day: base.day };
    }
    case 'yearly': {
      const year = base.year + n;
      return base.day > daysInMonth(year, base.month) ? null : { year, month: base.month, day: base.day };
    }
    default:
      return undefined;
  }
}

/**
 * Where to start counting.
 *
 * Counting from zero is only affordable when the window is near the series
 * start. A daily event begun three years ago needs n ≈ 1100 before it reaches
 * today, which is past the cap — so the occurrence in the window was never
 * generated and the event simply disappeared from any distant view. One step
 * of slack, because this is an estimate and a missed boundary occurrence is
 * the failure this exists to prevent.
 */
function firstStep(base: LocalParts, freq: string, windowStart: Date, timezone: string): number {
  const w = localPartsAt(windowStart, timezone);
  const gapDays = dayNumber(w.year, w.month, w.day) - dayNumber(base.year, base.month, base.day);
  switch (freq) {
    case 'daily': return Math.max(0, gapDays - 1);
    case 'weekly': return Math.max(0, Math.floor(gapDays / 7) - 1);
    case 'monthly': return Math.max(0, (w.year - base.year) * 12 + (w.month - base.month) - 1);
    case 'yearly': return Math.max(0, w.year - base.year - 1);
    default: return 0;
  }
}

/**
 * Expand `events` into the concrete occurrences that fall inside
 * [windowStart, windowEnd), stepping on `timezone`'s wall clock. Non-recurring
 * events pass through untouched when in-window; recurring events yield one
 * clone per occurrence (same id, shifted starts_at/ends_at). `recurrence_until`,
 * when set, ends the series.
 */
export function expandEventsInZone<T extends RecurrableEvent>(
  events: T[], windowStart: Date, windowEnd: Date, timezone: string,
  overlap = false,
  options: { requireComplete?: boolean; windowFrom?: string; windowTo?: string } = {},
): T[] {
  const incomplete = (reason: string) => new RangeError(`${reason}; the calendar window cannot be read whole`);
  if (!Number.isFinite(windowStart.getTime()) || !Number.isFinite(windowEnd.getTime()) || windowEnd < windowStart) {
    if (options.requireComplete) throw incomplete('Invalid recurrence window');
    return [];
  }
  const windowFrom = options.windowFrom ? parseExactInstant(options.windowFrom) : BigInt(windowStart.getTime()) * 1_000_000n;
  const windowTo = options.windowTo ? parseExactInstant(options.windowTo) : BigInt(windowEnd.getTime()) * 1_000_000n;
  if (windowTo < windowFrom) throw incomplete('Invalid recurrence window');
  const exact = (value: string) => {
    try { return parseExactInstant(value); }
    catch (error) { if (options.requireComplete) throw error; return BigInt(new Date(value).getTime()) * 1_000_000n; }
  };
  const out: T[] = [];
  for (const e of events) {
    const start = new Date(e.starts_at);
    if (Number.isNaN(start.getTime())) {
      if (options.requireComplete) throw incomplete('Invalid recurring event start');
      continue;
    }

    const startExact = exact(e.starts_at);
    if (!e.recurrence || e.recurrence === 'none') {
      if (startExact >= windowFrom && startExact < windowTo) out.push(e);
      continue;
    }

    const until = e.recurrence_until ? new Date(e.recurrence_until) : null;
    if (options.requireComplete && until && !Number.isFinite(until.getTime())) throw incomplete('Invalid recurrence cutoff');
    const untilExact = e.recurrence_until && until && Number.isFinite(until.getTime()) ? exact(e.recurrence_until) : null;
    const seriesEnd = untilExact !== null && untilExact < windowTo ? untilExact : windowTo;
    const durationMs = e.ends_at ? new Date(e.ends_at).getTime() - start.getTime() : null;
    if (options.requireComplete && durationMs !== null && !Number.isFinite(durationMs)) throw incomplete('Invalid recurring event end');
    const durationExact = e.ends_at && durationMs !== null && Number.isFinite(durationMs) ? exact(e.ends_at) - startExact : null;
    if (options.requireComplete && durationExact !== null && durationExact < 0n) throw incomplete('Invalid recurring event interval');
    const remainder = startExact - BigInt(start.getTime()) * 1_000_000n;
    const base = localPartsAt(start, timezone);
    const minutes = base.hour * 60 + base.minute;
    const subMinuteMs = start.getUTCSeconds() * 1000 + start.getUTCMilliseconds();
    // An explicit point is still a calendar occurrence, but occupies no
    // interval. Only a missing/invalid negative end keeps the legacy estimate.
    const busyDuration = durationExact !== null && durationExact >= 0n ? durationExact : 3_600_000_000_000n;
    const searchStart = overlap ? new Date(exactInstantMilliseconds(windowFrom - busyDuration)) : windowStart;
    const from = firstStep(base, e.recurrence, searchStart, timezone);

    // A complete reader must distinguish the budget from the end of a series.
    // Inspect, but never emit, the next valid step. At most eight years separate
    // leap days around a non-leap century; monthly gaps are shorter.
    let reachedEnd = false;
    const steps = MAX_OCCURRENCES + (options.requireComplete ? 8 : 0);
    for (let i = 0; i < steps; i += 1) {
      const local = steppedLocalDate(base, e.recurrence, from + i);
      if (local === undefined) {
        if (options.requireComplete) throw incomplete('Unsupported recurrence frequency');
        break;
      }
      if (local === null) continue;     // a day-of-month this month does not have
      // The local time may not exist on the night the clocks jump, or may
      // happen twice on the night they fall back. RFC 5545 §3.3.5 decides, as
      // the ICS readers that import these series do (instantForIcsLocalTime):
      // a time shown twice is its FIRST instant, and a skipped time takes the
      // offset in force BEFORE the gap — a weekly 2:30am in Chicago is 08:30Z
      // on 8 March 2026 (shown as 3:30 CDT), keeping its place in the night,
      // rather than vanishing for that day or sliding to 3:00.
      // The seed already names an exact instant, including which side of a
      // fall-back fold the user saved. Resolving its wall clock again can move
      // that first occurrence an hour earlier and out of its query window.
      const isSeed = from + i === 0;
      const cursor = isSeed ? new Date(start) : instantForIcsLocalTime(local.year, local.month, local.day, minutes, timezone);
      if (!cursor) continue;
      // Keep source precision within the resolver-selected local minute.
      if (!isSeed) cursor.setTime(cursor.getTime() + subMinuteMs);
      const cursorExact = isSeed ? startExact : BigInt(cursor.getTime()) * 1_000_000n + remainder;
      if (cursorExact >= seriesEnd) {
        reachedEnd = true;
        break; // the sequence is monotone in n
      }
      if (i >= MAX_OCCURRENCES) throw incomplete('Recurrence expansion exceeds its 500-step work limit');
      if (overlap && busyDuration > 0n ? cursorExact + busyDuration > windowFrom : cursorExact >= windowFrom) {
        // Derived occurrence clocks are lossless UTC projections. The stored
        // master remains untouched, including its original timestamp spelling.
        out.push({
          ...e,
          starts_at: formatExactInstant(cursorExact),
          ends_at: durationExact !== null ? formatExactInstant(cursorExact + durationExact) : null,
        });
      }
    }
    if (options.requireComplete && !reachedEnd) throw incomplete('Recurrence expansion could not establish the end of the window');
  }
  out.sort((a, b) => compareExactInstants(a.starts_at, b.starts_at));
  return out;
}

/**
 * Expand `events` into the occurrences ON the family dates [fromDay, toDay)
 * (`YYYY-MM-DD`, `toDay` exclusive): timed rows stepped on the family's wall
 * clock and kept when they start between the family's midnights; all-day rows
 * stepped by calendar date and kept when their own date (the UTC date their
 * instant is stored on, lib/calendar/day.ts) is one of those dates.
 *
 * `expandEventsInZone` over the family's midnights is right for a timed row and
 * wrong for an all-day one: an all-day Saturday is stored at Saturday 00:00Z,
 * which is Friday afternoon in Los Angeles, so a week window from Monday 00:00
 * Los Angeles time dropped Monday's all-day rows and kept the next Monday's.
 */
export function expandForFamily<T extends RecurrableEvent & { all_day?: boolean | null }>(
  events: T[], fromDay: string, toDay: string, timezone: string,
): T[] {
  const range = familyFetchRange(fromDay, toDay, timezone);
  const timed = events.filter((e) => !e.all_day);
  const allDay = events.filter((e) => e.all_day);
  return [
    ...expandEventsInZone(timed, range.timedFrom, range.timedTo, timezone),
    ...expandEventsInZone(allDay, range.allDayFrom, range.allDayTo, 'UTC'),
  ].sort((a, b) => compareExactInstants(a.starts_at, b.starts_at));
}

function runtimeTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/**
 * Expand on the RUNTIME's zone.
 *
 * Right for the browser views, where runtime-local is the person looking at the
 * screen. Anything running on a server should name the family's zone with
 * `expandEventsInZone` instead — there, runtime-local is UTC and belongs to
 * nobody.
 */
export function expandEvents<T extends RecurrableEvent>(
  events: T[], windowStart: Date, windowEnd: Date,
): T[] {
  return expandEventsInZone(events, windowStart, windowEnd, runtimeTimezone());
}
