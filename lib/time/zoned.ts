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
const DAY_MS = 24 * 60 * 60 * 1000;

/** Date.UTC treats years00–99 as1900–1999. Preserve the supplied Gregorian
 * year while retaining the same calendar overflow behavior for days/minutes. */
function utcMilliseconds(year: number, monthIndex: number, day: number, hour = 0, minute = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getTime();
}

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

/**
 * The calendar day an instant falls on, in `timezone`, as `YYYY-MM-DD`.
 *
 * This is the SAME answer `lib/services/scope.ts:dayKeyInTz` gives, and that
 * one now delegates here. It lives in this module because `scope.ts` carries
 * `import 'server-only'` and a client component may legitimately need to ask
 * the question: "does this expire today?" has to mean the same day for the
 * parent looking at a server-rendered page and the child looking at the
 * browser-rendered one, and it only does if both ask about the FAMILY's zone
 * rather than about whatever clock they happen to be standing next to.
 *
 * An unusable IANA name falls back to UTC rather than throwing, for the reason
 * `dayKeyInTz` already gives: a bad zone must not take a household's page down.
 */
export function dayKeyIn(instant: Date, timezone: string): string {
  try {
    const p = localPartsAt(instant, timezone);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** Zone offset in ms at a given instant (positive east of UTC). */
function offsetMsAt(instant: Date, timezone: string): number {
  const p = localPartsAt(instant, timezone);
  return utcMilliseconds(p.year, p.month - 1, p.day, p.hour, p.minute) - instant.getTime();
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
  const naive = utcMilliseconds(year, month - 1, day, hour, minute);
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

/**
 * The instant for a local time as RFC 5545 §3.3.5 reads it — the rule for a
 * calendar's DATE-TIME with a TZID, and so for anything stepped on a calendar's
 * wall clock (a recurring event's next occurrence).
 *
 *   - A reading the zone shows TWICE (the hour repeated when the clocks go
 *     back) is the FIRST of the two instants: TZID=Europe/London:20261025T013000
 *     is 00:30Z (01:30 BST), not 01:30Z (01:30 GMT); America/New_York
 *     2026-11-01 01:30 is 05:30Z (EDT).
 *   - A reading the zone SKIPS (the hour lost when the clocks go forward) is
 *     interpreted with the UTC offset in force BEFORE the gap:
 *     TZID=America/Chicago:20260308T023000 is 08:30Z (02:30 at CST's -6, which
 *     the clock shows as 03:30 CDT), not 08:00Z; Australia/Sydney 2026-10-04
 *     02:30 is 16:30Z on the 3rd (02:30 at AEST's +10, shown as 03:30 AEDT).
 *
 * That is NOT what `instantForLocalTime` does, deliberately: an ad or a daily
 * routine set for 02:30 posts at 03:00, the first minute that exists. A
 * calendar event published at 02:30 keeps its duration and its distance from
 * the rest of the night, as every RFC 5545 reader does. Both live here so the
 * two rules are named apart rather than one standing in for the other.
 *
 * The offsets in force within two days either side of the reading are the
 * candidates (that covers half-hour zones and date-line changes); a reading
 * one or more of them produce exactly is the earliest such instant, and a
 * reading none produces is a gap, resolved with the offset of the latest
 * candidate that reads before it. Null only for a reading no zone rule can
 * place (an unusable zone throws, as `localPartsAt` does).
 */
export function instantForIcsLocalTime(
  year: number, month: number, day: number, minutes: number, timezone: string,
): Date | null {
  const wall = utcMilliseconds(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  if (!Number.isFinite(wall)) return null;
  const reads = (instant: number) => {
    const p = localPartsAt(new Date(instant), timezone);
    return utcMilliseconds(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  const offsets = new Set([-2, -1, 0, 1, 2].map((days) => offsetMsAt(new Date(wall + days * DAY_MS), timezone)));
  const candidates = [...offsets].map((offset) => wall - offset).sort((a, b) => a - b);
  const exact = candidates.find((instant) => reads(instant) === wall);
  if (exact !== undefined) return new Date(exact);
  // A gap: the latest candidate that still reads before the requested time is
  // on the near side of it, and its offset is the one in force before the gap.
  const before = candidates.filter((instant) => reads(instant) < wall).at(-1);
  if (before === undefined) return instantForLocalTime(year, month, day, minutes, timezone);
  return new Date(wall - offsetMsAt(new Date(before), timezone));
}

/** Days in a month, so "the 31st" means the 28th/29th/30th where that is the end. */
export function daysInMonth(year: number, month: number): number {
  return new Date(utcMilliseconds(year, month, 0)).getUTCDate();
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
/**
 * `now` re-expressed so that UTC getters report the family's wall clock.
 *
 * The UTC twin of `asWallClockIn`, and the one a SERVER should use. A Date built
 * from local fields is normalised by the runtime's own DST rules, so on a host
 * in a DST-observing zone the family's wall clock can be silently moved before
 * anyone reads it back — 02:30 on a spring-forward morning becomes 03:30, and
 * the request the family actually made is gone. UTC observes no DST, so the
 * fields written are the fields read.
 *
 * Pair it with the parser's `{ utc: true }` option, and resolve the answer with
 * `instantForLocalTime`. Like its twin, the Date returned is NOT a real instant
 * and must never be stored.
 */
export function asWallClockUtc(instant: Date, timezone: string): Date {
  const p = localPartsAt(instant, timezone);
  return new Date(utcMilliseconds(p.year, p.month - 1, p.day, p.hour, p.minute));
}

export function asWallClockIn(instant: Date, timezone: string): Date {
  const p = localPartsAt(instant, timezone);
  const date = new Date(0);
  date.setFullYear(p.year, p.month - 1, p.day);
  date.setHours(p.hour, p.minute, 0, 0);
  return date;
}

/**
 * The instant a family's day begins, read in their own timezone.
 *
 * `new Date(); d.setHours(0, 0, 0, 0)` is the shape this replaces. It means
 * midnight *where the process is running*, which on a UTC host makes a
 * Californian family's "today" run 17:00 to 17:00 — yesterday evening's events
 * on today's list, and this evening's missing from it (F-017, F-F02). On a
 * browser that call is correct, because the browser IS the family; on a server
 * it is a different day.
 *
 * DST is the reason this goes through `instantForLocalTime` rather than
 * arithmetic: in a handful of zones — America/Santiago, Asia/Beirut and others
 * at various times — the clocks jump at midnight, so 00:00 does not exist on
 * that date. `instantForLocalTime` walks forward to the first minute that does,
 * which is the first moment of that day, rather than returning null and making
 * the caller handle a day that has no beginning.
 *
 * An unusable zone falls back to the host's midnight, which is exactly the old
 * behaviour: this is a correction, so it must never be the reason a page stops
 * rendering. `0449` and `isValidTimezone` keep unusable zones out of the
 * column in the first place.
 */
export function startOfLocalDay(instant: Date, timezone: string): Date {
  try {
    const p = localPartsAt(instant, timezone);
    const start = instantForLocalTime(p.year, p.month, p.day, 0, timezone);
    if (start) return start;
  } catch {
    // fall through
  }
  const fallback = new Date(instant);
  fallback.setHours(0, 0, 0, 0);
  return fallback;
}

/**
 * The instant the family's NEXT day begins — the exclusive end of "today".
 *
 * Not `startOfLocalDay(...) + 86_400_000`: a day is 23 or 25 hours on the two
 * DST changeovers, and adding a fixed 24 hours puts the boundary an hour inside
 * the next day or an hour short of the end of this one. Twice a year that is a
 * missing evening appointment or a duplicated morning one.
 */
export function startOfNextLocalDay(instant: Date, timezone: string): Date {
  try {
    const p = localPartsAt(instant, timezone);
    const nextDay = new Date(utcMilliseconds(p.year, p.month - 1, p.day + 1));
    const next = instantForLocalTime(
      nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, timezone,
    );
    if (next) return next;
  } catch {
    // fall through
  }
  return new Date(startOfLocalDay(instant, timezone).getTime() + 24 * 60 * 60 * 1000);
}
