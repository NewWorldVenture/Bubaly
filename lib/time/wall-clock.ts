// lib/time/wall-clock.ts — a family's wall clock as a value no device can move.
//
// A WALL READING is a Date whose UTC fields ARE a civil date and time in the
// family's zone: the family's 02:30 on 8 March reads 2026-03-08T02:30Z, on
// every phone, whatever that phone's own zone does that morning. UTC observes
// no daylight saving, so arithmetic on these fields (a day on, the first of the
// month, the Monday of the week) never meets a skipped or repeated hour, and
// nothing normalises the reading before `wallToInstant` turns it back into the
// real instant it names.
//
// It replaces a reading built from the DEVICE's local fields, which the device's
// DST rules silently rewrite (review 5370711559 on #688): a UTC family's 02:30
// on the morning Los Angeles springs forward became 03:30 on a phone there, and
// a UTC family's midnight on the day Santiago springs forward became 01:00, so
// a "today" query bound dropped an event at 00:30.
//
// A wall reading is never an instant: never store it, never format it as one,
// never compare it with `Date.now()`. Read it with `wallKey`/`wallParts`, move
// it with `addWallDays`/`wallMonthStart`, and leave it with `wallToInstant`.
// Framework-free and safe in a client bundle.
import { instantForLocalTime, localPartsAt } from '@/lib/time/zoned';

const pad = (n: number) => String(n).padStart(2, '0');

/** A wall reading from civil parts (`month` is 1–12; out-of-range days roll, as `Date.UTC` does). */
export function wallDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
}

/** The family's wall clock at `instant`, to the minute. */
export function wallAt(instant: Date, timezone: string): Date {
  const p = localPartsAt(instant, timezone);
  return wallDate(p.year, p.month, p.day, p.hour, p.minute);
}

/** A `YYYY-MM-DD` day at `hour:minute` (midnight by default), as a wall reading; an unreadable key reads NaN. */
export function wallFromKey(key: string, hour = 0, minute = 0): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m && Number(m[1]) >= 1 ? wallDate(Number(m[1]), Number(m[2]), Number(m[3]), hour, minute) : new Date(Number.NaN);
}

/** The `YYYY-MM-DD` a wall reading shows. */
export function wallKey(wall: Date): string {
  if (Number.isNaN(wall.getTime())) return '';
  const year = wall.getUTCFullYear();
  if (year < 1 || year > 9999) return '';
  return `${String(year).padStart(4, '0')}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`;
}

export type WallParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

/** The civil fields of a wall reading (`month` 1–12, `weekday` 0 = Sunday). */
export function wallParts(wall: Date): WallParts {
  return {
    year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate(),
    hour: wall.getUTCHours(), minute: wall.getUTCMinutes(), weekday: wall.getUTCDay(),
  };
}

/** `days` calendar days on (or back), keeping the time of day. */
export function addWallDays(wall: Date, days: number): Date {
  const p = wallParts(wall);
  return wallDate(p.year, p.month, p.day + days, p.hour, p.minute);
}

/** Midnight on the first of the month `months` from the reading's month. */
export function wallMonthStart(wall: Date, months = 0): Date {
  const p = wallParts(wall);
  return wallDate(p.year, p.month + months, 1);
}

/** Days in the reading's month. */
export function wallDaysInMonth(wall: Date): number {
  const p = wallParts(wall);
  return wallDate(p.year, p.month + 1, 0).getUTCDate();
}

/** Midnight on the Monday of the reading's week, `weeks` weeks on. */
export function wallWeekStart(wall: Date, weeks = 0): Date {
  const p = wallParts(wall);
  return wallDate(p.year, p.month, p.day - ((p.weekday + 6) % 7) + weeks * 7);
}

/**
 * The real instant a wall reading names in `timezone`. A reading the zone skips
 * at spring-forward resolves to the first minute that exists (as
 * `instantForLocalTime` does). An unusable zone or reading comes back as NaN
 * rather than a plausible wrong instant.
 */
export function wallToInstant(wall: Date, timezone: string): Date {
  if (Number.isNaN(wall.getTime())) return new Date(Number.NaN);
  const p = wallParts(wall);
  if (p.year < 1 || p.year > 9999) return new Date(Number.NaN);
  try {
    const at = instantForLocalTime(p.year, p.month, p.day, p.hour * 60 + p.minute, timezone);
    if (at) {
      const result = new Date(at.getTime() + wall.getUTCSeconds() * 1000 + wall.getUTCMilliseconds());
      if (result.getUTCFullYear() >= 1 && result.getUTCFullYear() <= 9999) return result;
    }
  } catch {
    // an unusable zone: fall through
  }
  return new Date(Number.NaN);
}
