// lib/time/civil.ts — a zone-less civil reading ("2026-10-12T09:00", with or
// without seconds and a fraction, or a bare "2026-10-12") as the instant it
// names on a family's clock. ONE grammar and ONE rule, for every surface that
// takes such a string: the `datetime-local` inputs (lib/time/datetime-local.ts),
// reminders, and the school/sports read windows.
//
// Each of those had its own parser, and they disagreed. A fraction
// ("09:00:00.000") missed the reminders' pattern and fell through to
// `Date.parse`, which reads a zone-less string on the HOST's clock — 09:00Z for
// a Los Angeles family instead of 16:00Z. An impossible date (2026-02-30) was
// rolled into March instead of refused. The skipped hour of spring-forward
// resolved three different ways (03:00, 01:30 PST and 03:30 PDT for the same
// Los Angeles 02:30), and the repeated hour of fall-back to the FIRST instant
// in western zones and the SECOND in eastern ones.
//
// THE RULE is RFC 5545 §3.3.5, which the calendar already applies to the same
// strings (`normalizeCalendarWindowInstant`, via `instantForIcsLocalTime`):
//
//   - A reading the zone shows TWICE (fall-back) is the FIRST of the two
//     instants, in every zone: Los Angeles 2026-11-01 01:30 is 08:30Z (PDT);
//     Berlin 2026-10-25 02:30 is 00:30Z (CEST).
//   - A reading the zone SKIPS (spring-forward) is read with the offset in
//     force BEFORE the gap, so it keeps its distance from the rest of the
//     night: Los Angeles 2026-03-08 02:30 is 10:30Z, which the clock shows as
//     03:30 PDT.
//   - A gap AT midnight (America/Santiago 2026-09-06, Asia/Beirut on its
//     spring-forward Sunday) is the same rule: 00:00 resolves to the instant
//     the clocks jump, which is where that day begins, and 00:30 to half an
//     hour after it.
//   - A bare date, read as the start of a day, is that day's first instant —
//     00:00 by the rule above, which is the jump itself on a midnight-gap day.
//   - Seconds and milliseconds are kept exactly; a fraction finer than a
//     millisecond with a non-zero digit is refused, never rounded.
//   - Anything that is not a real calendar date and clock (02-30, 24:00,
//     minute 60) is refused, never normalised.
//
// Framework-free and safe in a client bundle.
import { daysInMonth, instantForIcsLocalTime, isValidTimezone } from '@/lib/time/zoned';

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/;
const ZONED = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([zZ]|[+-]\d{2}:?\d{2})$/;

/** A civil date and (optionally) clock reading, validated field by field. */
export type CivilReading = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** False for a bare `YYYY-MM-DD`. */
  hasTime: boolean;
};

/**
 * A zone-less `YYYY-MM-DD[THH:mm[:ss[.fraction]]]` (a space may stand for the
 * `T`), or null when it is not one or names a date or time that does not exist.
 * A string carrying `Z` or an offset is NOT a civil reading: see `zonedInstant`.
 */
export function parseCivilReading(value: string | null | undefined): CivilReading | null {
  const m = CIVIL.exec((value ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, fraction] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  const hasTime = h !== undefined;
  const hour = hasTime ? Number(h) : 0;
  const minute = hasTime ? Number(mi) : 0;
  const second = s ? Number(s) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const digits = (fraction ?? '').padEnd(3, '0');
  if (/[1-9]/.test(digits.slice(3))) return null;
  return { year, month, day, hour, minute, second, millisecond: Number(digits.slice(0, 3)), hasTime };
}

/**
 * The instant a civil reading names on `timezone`'s clock, by the rule in the
 * header (RFC 5545 §3.3.5: a repeated reading is the first instant, a skipped
 * one uses the offset before the gap). Null for an unusable zone.
 */
export function civilToInstant(reading: CivilReading, timezone: string): Date | null {
  if (typeof timezone !== 'string' || !timezone || !isValidTimezone(timezone)) return null;
  try {
    const at = instantForIcsLocalTime(reading.year, reading.month, reading.day, reading.hour * 60 + reading.minute, timezone);
    if (!at) return null;
    const ms = at.getTime() + reading.second * 1000 + reading.millisecond;
    return Number.isFinite(ms) ? new Date(ms) : null;
  } catch {
    return null;
  }
}

/**
 * The first instant of a civil day on `timezone`'s clock and the first instant
 * of the next one (an exclusive end). Not `start + 24h`: a day is 23 or 25
 * hours on the changeovers, and on a midnight-gap day it starts at 01:00.
 */
export function civilDayBounds(year: number, month: number, day: number, timezone: string): { start: Date; end: Date } | null {
  const next = new Date(0);
  next.setUTCFullYear(year, month - 1, day + 1);
  const at = (y: number, m: number, d: number) => civilToInstant({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0, millisecond: 0, hasTime: true }, timezone);
  const start = at(year, month, day);
  const end = at(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return start && end && end > start ? { start, end } : null;
}

/**
 * A timestamp that SAYS its zone (`Z`, `+09:00`, `-0400`), as an instant — or
 * null. The date and clock are validated like a civil reading first, so an
 * impossible date is refused rather than rolled by `Date.parse`, and nothing
 * zone-less ever reaches `Date.parse`, which would read it on the host's clock.
 */
export function zonedInstant(value: string | null | undefined): Date | null {
  const m = ZONED.exec((value ?? '').trim());
  if (!m) return null;
  const [, year, month, day, hour, minute, second = '00', fraction, designator] = m;
  // The calendar date is checked as written — `Date.parse` would roll 30
  // February into March — including the expanded years a timestamp may carry.
  const date = `${year}-${month}-${day}`;
  const midnight = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().split('T')[0] !== date) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  // The fraction of an instant that says its zone (Postgres writes six digits)
  // is precision, not a reading; a Date keeps the millisecond.
  const zone = designator.toUpperCase() === 'Z' ? 'Z' : designator.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const [hh, mm] = zone === 'Z' ? [0, 0] : zone.slice(1).split(':').map(Number);
  if (hh > 23 || mm > 59) return null;
  const ms = Date.parse(`${date}T${hour}:${minute}:${second}${fraction ? `.${fraction}` : ''}${zone}`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * A reminder- or window-style instant: a civil reading on the family's clock
 * (a bare date is the start of that day), else a timestamp with its own zone,
 * else null. Never a host-clock reading.
 */
export function familyInstant(value: string | null | undefined, timezone: string): Date | null {
  const reading = parseCivilReading(value);
  if (reading) return civilToInstant(reading, timezone);
  return zonedInstant(value);
}
