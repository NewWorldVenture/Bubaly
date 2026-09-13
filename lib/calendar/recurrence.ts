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
  daysInMonth, instantForLocalTime, localPartsAt, type LocalParts,
} from '@/lib/time/zoned';

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
const dayNumber = (year: number, month: number, day: number) =>
  Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);

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
      const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day + (freq === 'daily' ? n : n * 7)));
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
): T[] {
  const out: T[] = [];
  for (const e of events) {
    const start = new Date(e.starts_at);
    if (Number.isNaN(start.getTime())) continue;

    if (!e.recurrence || e.recurrence === 'none') {
      if (start >= windowStart && start < windowEnd) out.push(e);
      continue;
    }

    const until = e.recurrence_until ? new Date(e.recurrence_until) : null;
    const seriesEnd = until && until < windowEnd ? until : windowEnd;
    const durationMs = e.ends_at ? new Date(e.ends_at).getTime() - start.getTime() : null;
    const base = localPartsAt(start, timezone);
    const minutes = base.hour * 60 + base.minute;
    const from = firstStep(base, e.recurrence, windowStart, timezone);

    for (let i = 0; i < MAX_OCCURRENCES; i += 1) {
      const local = steppedLocalDate(base, e.recurrence, from + i);
      if (local === undefined) break;   // a frequency we do not know
      if (local === null) continue;     // a day-of-month this month does not have
      // The local time itself may not exist on the morning the clocks jump;
      // instantForLocalTime moves it to the first minute that does, so a 2:30am
      // event happens at 3:00 rather than vanishing for that day.
      const cursor = instantForLocalTime(local.year, local.month, local.day, minutes, timezone);
      if (!cursor) continue;
      if (cursor >= seriesEnd) break;   // the sequence is monotone in n
      if (cursor >= windowStart) {
        out.push({
          ...e,
          starts_at: cursor.toISOString(),
          ends_at: durationMs !== null ? new Date(cursor.getTime() + durationMs).toISOString() : null,
        });
      }
    }
  }
  out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return out;
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
