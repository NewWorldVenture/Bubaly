import { parseExactInstant, formatExactInstant, exactInstantMilliseconds, addExactMilliseconds, inclusiveInstantStep, normalizeExactInstant } from '../calendar/exact-instant';
import { instantForIcsLocalTime, isValidTimezone } from '../time/zoned';
const DAY_MS = 86_400_000;

function calendarAnchor(dayKey: string): number {
  const anchor = Date.parse(`${dayKey}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !Number.isFinite(anchor) || new Date(anchor).toISOString().slice(0, 10) !== dayKey) {
    throw new RangeError('Invalid calendar date');
  }
  return anchor;
}

/** First instant on/after a date, including skipped midnight or a skipped date. */
function firstInstantOnOrAfterDay(dayKey: string, formatter: Intl.DateTimeFormat): string {
  const anchor = calendarAnchor(dayKey);
  const keyAt = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value.padStart(type === 'year' ? 4 : 2, '0')).join('-');
  };
  // A fixed 72-hour bracket covers IANA offsets and bounds the search to 28
  // bisections at millisecond precision. Reuse the window's single formatter.
  let before = anchor - 36 * 3_600_000;
  let after = anchor + 36 * 3_600_000;
  if (keyAt(before) >= dayKey || keyAt(after) <= dayKey) throw new RangeError('Calendar date is outside the search bounds');
  while (after - before > 1) {
    const middle = before + Math.floor((after - before) / 2);
    if (keyAt(middle) < dayKey) before = middle;
    else after = middle;
  }
  // A whole skipped date has no instants; its boundary is the following date's
  // first instant. The separate all-day UTC date bounds keep their original key.
  return new Date(after).toISOString();
}

/**
 * A PostgREST OR filter applied before the reader's order/limit. Timed rows use
 * family-local instants; all-day rows retain their stored calendar date. This
 * selects start dates only, without expanding multi-day events or recurrence.
 */
export function briefingCalendarWindow(dayKey: string, timezone: string, fromDay: number, dayCount: number): string {
  return calendarWindowFilter(briefingCalendarBounds(dayKey, timezone, fromDay, dayCount));
}

/**
 * The two halves of a calendar window: timed rows are bounded by family-local
 * instants, all-day rows by their stored calendar DATE (an all-day event is
 * stored as UTC midnight of the day on the family's wall, whatever their zone).
 * `timedTo` and `allDayToDay` are exclusive.
 */
export type CalendarWindowBounds = { timedFrom: string; timedTo: string; allDayFromDay: string; allDayToDay: string };

/** The bounds `briefingCalendarWindow` filters by: `dayCount` family days starting `fromDay` days after `dayKey`. */
export function briefingCalendarBounds(dayKey: string, timezone: string, fromDay: number, dayCount: number): CalendarWindowBounds {
  if (!Number.isSafeInteger(fromDay) || fromDay < 0 || !Number.isSafeInteger(dayCount) || dayCount <= 0) throw new RangeError('Invalid calendar window');
  const anchor = calendarAnchor(dayKey);
  const dateAt = (offset: number) => new Date(anchor + offset * DAY_MS).toISOString().slice(0, 10);
  const firstDay = dateAt(fromDay);
  const endDay = dateAt(fromDay + dayCount);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return {
    timedFrom: firstInstantOnOrAfterDay(firstDay, formatter),
    timedTo: firstInstantOnOrAfterDay(endDay, formatter),
    allDayFromDay: firstDay,
    allDayToDay: endDay,
  };
}

/**
 * Bounds for a window the caller already holds as instants — a rolling week
 * from `fromIso` through `toInclusiveIso` (the last millisecond, as the weekly
 * windows are built). Finer input clocks include only their declared unit;
 * legacy clocks through millisecond precision retain the one-ms extension.
 * All-day rows take the family-local dates those instants
 * fall on, so a Saturday all-day event in Los Angeles belongs to Saturday.
 */
export function instantCalendarBounds(fromIso: string, toInclusiveIso: string, timezone: string): CalendarWindowBounds {
  const from = parseExactInstant(normalizeCalendarWindowInstant(fromIso, timezone));
  const normalizedTo = normalizeCalendarWindowInstant(toInclusiveIso, timezone);
  const toInclusive = parseExactInstant(normalizedTo);
  if (toInclusive < from) throw new RangeError('Invalid calendar window');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const keyAt = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value.padStart(type === 'year' ? 4 : 2, '0')).join('-');
  };
  const lastDay = keyAt(exactInstantMilliseconds(toInclusive));
  return {
    timedFrom: formatExactInstant(from),
    timedTo: formatExactInstant(toInclusive + inclusiveInstantStep(normalizedTo)),
    allDayFromDay: keyAt(exactInstantMilliseconds(from)),
    allDayToDay: new Date(calendarAnchor(lastDay) + DAY_MS).toISOString().slice(0, 10),
  };
}

/** Read-window compatibility: a valid bare DATE names UTC midnight; an explicit
 * local DATETIME names the supplied family's clock, with RFC gap/fold handling.
 * Stored native clocks still require the strict timestamp grammar. Preserve the
 * declared fractional unit rather than borrowing the host timezone. */
export function normalizeCalendarWindowInstant(value: string, timezone = 'UTC'): string {
  if (typeof timezone !== 'string' || !timezone || !isValidTimezone(timezone)) throw new RangeError('Invalid calendar timezone');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    calendarAnchor(value);
    return normalizeExactInstant(`${value}T00:00:00Z`);
  }
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(value);
  if (local) {
    const [, day, hour, minute, second = '00', fraction = ''] = local;
    // Validate every civil/clock field with the strict parser before resolving
    // the minute. Add seconds and fractional ticks exactly after zone resolution.
    parseExactInstant(`${day}T${hour}:${minute}:${second}${fraction ? `.${fraction}` : ''}Z`);
    const [year, month, date] = day.split('-').map(Number);
    const resolved = instantForIcsLocalTime(year, month, date, Number(hour) * 60 + Number(minute), timezone);
    if (!resolved) throw new RangeError('Invalid calendar local time');
    const exact = BigInt(resolved.getTime()) * 1_000_000n + BigInt(second) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0') || '0');
    const normalized = formatExactInstant(exact);
    return normalized.slice(0, 20) + normalized.slice(20, -1).padEnd(Math.max(3, fraction.length), '0') + 'Z';
  }
  return normalizeExactInstant(value);
}

/** The PostgREST OR filter for a window's two halves, for the rows that are NOT series. */
export function calendarWindowFilter(bounds: CalendarWindowBounds): string {
  return `and(all_day.eq.false,starts_at.gte.${bounds.timedFrom},starts_at.lt.${bounds.timedTo}),`
    + `and(all_day.eq.true,starts_at.gte.${bounds.allDayFromDay}T00:00:00.000Z,starts_at.lt.${bounds.allDayToDay}T00:00:00.000Z)`;
}

/**
 * The same two halves from the window's START on, with no end — the calendar
 * search with no `to` reads every one-off ahead, as it always did, while its
 * series are expanded over a bounded horizon.
 */
export function calendarOpenWindowFilter(bounds: Pick<CalendarWindowBounds, 'timedFrom' | 'allDayFromDay'>): string {
  return `and(all_day.eq.false,starts_at.gte.${bounds.timedFrom}),`
    + `and(all_day.eq.true,starts_at.gte.${bounds.allDayFromDay}T00:00:00.000Z)`;
}

/** Calendar starts plus half-open ongoing intervals. Explicit points occupy no interval; missing ends estimate one hour / one date. */
export function calendarOverlapWindowFilter(bounds: CalendarWindowBounds): string {
  const fallbackFrom = addExactMilliseconds(bounds.timedFrom, -3_600_000);
  const dayFrom = `${bounds.allDayFromDay}T00:00:00.000Z`;
  const dayTo = `${bounds.allDayToDay}T00:00:00.000Z`;
  return `and(all_day.eq.false,starts_at.gte.${bounds.timedFrom},starts_at.lt.${bounds.timedTo}),`
    + `and(all_day.eq.false,starts_at.lt.${bounds.timedTo},ends_at.gt.${bounds.timedFrom}),`
    + `and(all_day.eq.false,starts_at.lt.${bounds.timedTo},ends_at.is.null,starts_at.gt.${fallbackFrom}),`
    + `and(all_day.eq.true,starts_at.lt.${dayTo},ends_at.gt.${dayFrom}),`
    + `and(all_day.eq.true,starts_at.lt.${dayTo},ends_at.is.null,starts_at.gte.${dayFrom})`;
}
