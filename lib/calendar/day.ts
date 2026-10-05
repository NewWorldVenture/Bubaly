// lib/calendar/day.ts — the day a calendar occurrence is ON.
//
// A timed row is an instant, and the day it is on is the FAMILY's: 23:30 on a
// Friday in Los Angeles is Saturday 06:30Z and belongs to Friday.
//
// An all-day row is a DATE — "Saturday" — stored as an instant on that date in
// UTC: Saturday 00:00Z, whatever zone the family lives in (the feed importer,
// lib/sync/ics.ts, and the window the briefs read, lib/briefing/calendar-
// window.ts, both say so). Read through the family's clock that instant is
// Friday 17:00 in Los Angeles, so every surface that keyed an all-day row by the
// family's day of its instant drew a Saturday birthday on Friday anywhere west
// of Greenwich; and a read that began at the family's midnight (Saturday 07:00Z
// in Los Angeles) never fetched Saturday's all-day row at all. An all-day row is
// on its own date — its UTC calendar date — on every clock.
//
// These are the shared answers: which day a row is on, the order a day's list
// is in, the run of dates a view covers, and the instants a read of those dates
// must span. Framework-free and safe in a client bundle.
import { dayKeyIn } from '@/lib/time/zoned';
import { wallFromKey, wallToInstant } from '@/lib/time/wall-clock';

/** The fields that decide which day a row is on. */
export type DayRow = { starts_at: string; all_day?: boolean | null };

const DAY_MS = 86_400_000;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A timestamp that names its zone (`Z`, `+00:00`, `-0500`). */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The date an all-day row is on: its instant's UTC calendar date, `YYYY-MM-DD`;
 * '' when unreadable. A bare date, or a zone-less `YYYY-MM-DDT00:00:00` (the
 * synthetic birthday rows, lib/moments/birthdays.ts), is that date as written —
 * parsing one would read it on the host's clock.
 */
export function allDayDate(startsAt: string): string {
  if (DATE_KEY.test(startsAt)) return startsAt;
  if (/^\d{4}-\d{2}-\d{2}T/.test(startsAt) && !HAS_ZONE.test(startsAt)) return startsAt.slice(0, 10);
  const ms = Date.parse(startsAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

/**
 * The family date an occurrence is on: a timed row's day on the family's wall
 * clock, an all-day row's own date. '' for a row whose start cannot be read.
 */
export function occurrenceDay(row: DayRow, timezone: string): string {
  if (row.all_day) return allDayDate(row.starts_at);
  const ms = Date.parse(row.starts_at);
  if (!Number.isFinite(ms)) return '';
  return dayKeyIn(new Date(ms), timezone);
}

/**
 * The order a list of occurrences is read in: by the date each is on; within a
 * date, all-day rows first (they are the day's heading, not its first hour —
 * at Tokyo's +9 an all-day row's instant is 09:00, after the 08:00 school run);
 * then by start; then by id, so equal starts have one order on every render.
 */
export function compareOccurrences(
  a: DayRow & { id?: unknown }, b: DayRow & { id?: unknown }, timezone: string,
): number {
  const dayA = occurrenceDay(a, timezone);
  const dayB = occurrenceDay(b, timezone);
  if (dayA !== dayB) return dayA < dayB ? -1 : 1;
  const allDayA = a.all_day ? 0 : 1;
  const allDayB = b.all_day ? 0 : 1;
  if (allDayA !== allDayB) return allDayA - allDayB;
  const startA = Date.parse(a.starts_at);
  const startB = Date.parse(b.starts_at);
  if (startA !== startB && Number.isFinite(startA) && Number.isFinite(startB)) return startA - startB;
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

/** The date `days` calendar days from `day` (`YYYY-MM-DD`), on the date, never on an instant. */
export function addDays(day: string, days: number): string {
  const anchor = Date.parse(`${day}T12:00:00.000Z`);
  if (!DATE_KEY.test(day) || !Number.isFinite(anchor)) return '';
  return new Date(anchor + days * DAY_MS).toISOString().slice(0, 10);
}

/** `count` consecutive family dates starting at `fromDay`. */
export function familyDates(fromDay: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = addDays(fromDay, i);
    if (!day) return [];
    out.push(day);
  }
  return out;
}

/**
 * The instants a read must span to hold every row ON the family dates
 * [fromDay, toDay): timed rows from the family's midnight starting `fromDay`
 * to the one starting `toDay`; all-day rows from `fromDay` 00:00Z to `toDay`
 * 00:00Z. `from`/`to` are the union — the fetch window — and the two halves are
 * what an expander or a filter applies to each kind of row.
 *
 * East of Greenwich the family's midnight comes first and the all-day half ends
 * last; west of it the all-day half starts first. A window that began at the
 * family's midnight missed the first date's all-day rows west of Greenwich, and
 * one that ended at the family's midnight missed the last date's east of it.
 * An unusable zone reads as UTC rather than as no window at all.
 */
export type FamilyFetchRange = {
  from: Date; to: Date;
  timedFrom: Date; timedTo: Date;
  allDayFrom: Date; allDayTo: Date;
};

export function familyFetchRange(fromDay: string, toDay: string, timezone: string): FamilyFetchRange {
  const allDayFrom = new Date(`${fromDay}T00:00:00.000Z`);
  const allDayTo = new Date(`${toDay}T00:00:00.000Z`);
  const zonedFrom = wallToInstant(wallFromKey(fromDay), timezone);
  const zonedTo = wallToInstant(wallFromKey(toDay), timezone);
  const timedFrom = Number.isFinite(zonedFrom.getTime()) ? zonedFrom : allDayFrom;
  const timedTo = Number.isFinite(zonedTo.getTime()) ? zonedTo : allDayTo;
  return {
    from: timedFrom < allDayFrom ? timedFrom : allDayFrom,
    to: timedTo > allDayTo ? timedTo : allDayTo,
    timedFrom, timedTo, allDayFrom, allDayTo,
  };
}

/** True when a row is on one of the family dates [fromDay, toDay). */
export function isOnFamilyDates(row: DayRow, fromDay: string, toDay: string, timezone: string): boolean {
  const day = occurrenceDay(row, timezone);
  return day !== '' && day >= fromDay && day < toDay;
}
