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
 * windows are built). All-day rows take the family-local dates those instants
 * fall on, so a Saturday all-day event in Los Angeles belongs to Saturday.
 */
export function instantCalendarBounds(fromIso: string, toInclusiveIso: string, timezone: string): CalendarWindowBounds {
  const from = Date.parse(fromIso);
  const toInclusive = Date.parse(toInclusiveIso);
  if (!Number.isFinite(from) || !Number.isFinite(toInclusive) || toInclusive < from) throw new RangeError('Invalid calendar window');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const keyAt = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value.padStart(type === 'year' ? 4 : 2, '0')).join('-');
  };
  const lastDay = keyAt(toInclusive);
  return {
    timedFrom: new Date(from).toISOString(),
    timedTo: new Date(toInclusive + 1).toISOString(),
    allDayFromDay: keyAt(from),
    allDayToDay: new Date(calendarAnchor(lastDay) + DAY_MS).toISOString().slice(0, 10),
  };
}

/** The PostgREST OR filter for a window's two halves, for the rows that are NOT series. */
export function calendarWindowFilter(bounds: CalendarWindowBounds): string {
  return `and(all_day.eq.false,starts_at.gte.${bounds.timedFrom},starts_at.lt.${bounds.timedTo}),`
    + `and(all_day.eq.true,starts_at.gte.${bounds.allDayFromDay}T00:00:00.000Z,starts_at.lt.${bounds.allDayToDay}T00:00:00.000Z)`;
}
