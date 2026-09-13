// lib/time/zoned.ts
//
// Wall-clock arithmetic in a named IANA zone.
//
// These started life inside the recurring-ads scheduler, which was the first
// thing here that had to answer "what instant is 9am on Tuesday *for this
// family*". The assistant bridge now has the same question and a worse version
// of the bug: a spoken "Friday at 4pm" was being resolved with the RUNTIME's
// local calendar, which on a server is UTC, so a family in New York got an
// event at noon. A browser gets this right by accident — there, runtime-local
// IS the person's zone. Server-side it is wrong for everyone outside UTC.
//
// Two subsystems needing them makes a marketing module the wrong home, so they
// live here. `lib/marketing/recurring-ads.ts` re-exports the ones it had made
// public, and its behaviour is unchanged.

/** A wall-clock reading, as an observer in some zone would report it. */
export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

export const MINUTES_PER_DAY = 24 * 60;

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let dtf = partsCache.get(timezone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    partsCache.set(timezone, dtf);
  }
  return dtf;
}

/** The wall-clock reading an observer in `timezone` sees at `instant`. */
export function localPartsAt(instant: Date, timezone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // 'en-US' with hour12:false renders midnight as 24 in some ICU versions.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** Zone offset in ms at a given instant (positive east of UTC). */
function offsetMsAt(instant: Date, timezone: string): number {
  const p = localPartsAt(instant, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - instant.getTime();
}

/**
 * The instant at which the clock in `timezone` reads the given local time.
 *
 * Returns null when that reading never happens — the hour skipped by
 * spring-forward. The caller decides what to do about it rather than being
 * handed a silently wrong instant.
 *
 * Two passes: the first guesses using the offset at the naive instant, the
 * second corrects it using the offset actually in force there. That converges
 * for every real zone, and the verification step catches the gap.
 */
export function zonedLocalToInstant(
  year: number, month: number, day: number, minutes: number, timezone: string,
): Date | null {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let ts = naive - offsetMsAt(new Date(naive), timezone);
  ts = naive - offsetMsAt(new Date(ts), timezone);
  const check = localPartsAt(new Date(ts), timezone);
  const matches = check.year === year && check.month === month && check.day === day
    && check.hour === hour && check.minute === minute;
  return matches ? new Date(ts) : null;
}

/**
 * The instant for a local time, moved forward when that time does not exist.
 *
 * An ad set for 02:30 must still post on the morning the clocks jump from
 * 02:00 to 03:00 — at 03:00, the first moment that exists — rather than
 * vanishing for that day. Searching minute by minute is bounded by the largest
 * real DST jump and costs nothing at this cadence.
 */
export function instantForLocalTime(
  year: number, month: number, day: number, minutes: number, timezone: string,
): Date | null {
  for (let m = minutes; m < MINUTES_PER_DAY; m += 1) {
    const instant = zonedLocalToInstant(year, month, day, m, timezone);
    if (instant) return instant;
  }
  return null;
}

/** Days in a month, so "the 31st" means the 28th/29th/30th where that is the end. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * `now` re-expressed so that RUNTIME-LOCAL getters report the family's wall
 * clock.
 *
 * This is the bridge to code that does its date arithmetic with `getHours()` /
 * `setDate()` — the whole of `lib/capture/parse.ts`, which is right in a
 * browser and wrong on a server. Hand it one of these and its "today",
 * "tomorrow" and "next Friday" are the family's, not the runtime's. The Date
 * returned is NOT a real instant and must never be stored: read its wall-clock
 * fields back out and resolve them with `zonedLocalToInstant`.
 */
export function asWallClockIn(instant: Date, timezone: string): Date {
  const p = localPartsAt(instant, timezone);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
}
