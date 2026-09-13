import { canonicalZone, shiftedDay, validDay } from '@/lib/onboarding/ics-time';

export function displayTimezone(raw: unknown): { timezone: string; timezoneFallback: boolean } {
  try { return { timezone: canonicalZone(typeof raw === 'string' ? raw : ''), timezoneFallback: false }; }
  catch { return { timezone: 'UTC', timezoneFallback: true }; }
}

function dateFormatter(timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formattedDay(date: Date, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value.padStart(type === 'year' ? 4 : 2, '0')).join('-');
}

export function displayDayKey(date: Date, timezone = 'UTC'): string | null {
  if (!Number.isFinite(date.getTime())) return null;
  return formattedDay(date, dateFormatter(displayTimezone(timezone).timezone));
}

/** Same bounded civil-day search as briefing/calendar-window, including skipped midnight/date. */
function dayBoundary(day: string, formatter: Intl.DateTimeFormat): Date {
  if (!validDay(day)) throw new RangeError('Invalid display calendar date');
  const anchor = Date.parse(`${day}T12:00:00Z`);
  let before = anchor - 36 * 3_600_000, after = anchor + 36 * 3_600_000;
  const keyAt = (ms: number) => formattedDay(new Date(ms), formatter);
  if (keyAt(before) >= day || keyAt(after) <= day) throw new RangeError('Display date is outside calendar bounds');
  while (after - before > 1) {
    const middle = before + Math.floor((after - before) / 2);
    if (keyAt(middle) < day) before = middle;
    else after = middle;
  }
  return new Date(after);
}

export type DisplayCalendarWindow = { firstDay: string; endDay: string; start: Date; end: Date };

export function displayCalendarWindow(firstDay: string, endDay: string, timezone: string): DisplayCalendarWindow {
  if (!validDay(firstDay) || !validDay(endDay) || endDay <= firstDay) throw new RangeError('Invalid display calendar window');
  const formatter = dateFormatter(displayTimezone(timezone).timezone);
  return { firstDay, endDay, start: dayBoundary(firstDay, formatter), end: dayBoundary(endDay, formatter) };
}

export function familyDisplayCalendar(now: Date, rawTimezone: unknown) {
  const zone = displayTimezone(rawTimezone);
  const dayKey = displayDayKey(now, zone.timezone);
  if (!dayKey || !validDay(dayKey)) throw new RangeError('Invalid display clock');
  const [year, month, today] = dayKey.split('-').map(Number);
  const firstMonthDay = `${dayKey.slice(0, 7)}-01`;
  const nextMonth = shiftedDay(firstMonthDay, 32).slice(0, 7) + '-01';
  return {
    ...zone, dayKey, year, month: month - 1, today,
    todayWindow: displayCalendarWindow(dayKey, shiftedDay(dayKey, 1), zone.timezone),
    upcomingWindow: displayCalendarWindow(shiftedDay(dayKey, 1), shiftedDay(dayKey, 14), zone.timezone),
    monthWindow: displayCalendarWindow(firstMonthDay, nextMonth, zone.timezone),
  };
}

/** Timed instants overlap [start,end); all-day storage uses separate UTC calendar dates. */
export function displayCalendarFilter(window: DisplayCalendarWindow): string {
  const overlap = (allDay: boolean, start: string, end: string) =>
    `and(all_day.eq.${allDay},starts_at.lt.${end},ends_at.gt.${start}),`
    + `and(all_day.eq.${allDay},starts_at.lt.${end},starts_at.gte.${start})`;
  return overlap(false, window.start.toISOString(), window.end.toISOString()) + ','
    + overlap(true, `${window.firstDay}T00:00:00.000Z`, `${window.endDay}T00:00:00.000Z`);
}

export type CalendarDisplayEvent = { starts_at: string; ends_at?: string | null; all_day?: boolean };

/** Invalid/missing ends are an unknown duration: list the start, never invent occupancy. */
export function eventOverlapsWindow(event: CalendarDisplayEvent, window: DisplayCalendarWindow): boolean {
  if (typeof event.starts_at !== 'string') return false;
  if (event.all_day) {
    const start = event.starts_at.slice(0, 10), rawEnd = event.ends_at?.slice(0, 10);
    if (!validDay(start)) return false;
    const end = rawEnd && validDay(rawEnd) && rawEnd > start ? rawEnd : shiftedDay(start, 1);
    return start < window.endDay && end > window.firstDay;
  }
  if (window.end.getTime() <= window.start.getTime()) return false;
  const start = Date.parse(event.starts_at), end = event.ends_at ? Date.parse(event.ends_at) : NaN;
  if (!Number.isFinite(start)) return false;
  return Number.isFinite(end) && end > start
    ? start < window.end.getTime() && end > window.start.getTime()
    : start >= window.start.getTime() && start < window.end.getTime();
}

/** A mark on every occupied family date, with all-day end dates kept exclusive. */
export function displayEventDays(events: readonly CalendarDisplayEvent[], window: DisplayCalendarWindow, timezone: string): number[] {
  const days: number[] = [];
  for (let day = window.firstDay, count = 0; day < window.endDay && count < 31; day = shiftedDay(day, 1), count++) {
    const slice = displayCalendarWindow(day, shiftedDay(day, 1), timezone);
    if (events.some(event => eventOverlapsWindow(event, slice))) days.push(Number(day.slice(8, 10)));
  }
  return days;
}

/** Snooze delays a reminder; it cannot move a future reminder earlier. */
export function displayReminderTime(row: { remind_at: string | null; status: string; snoozed_until?: string | null }): string | null {
  const start = row.remind_at ? Date.parse(row.remind_at) : NaN;
  if (!Number.isFinite(start)) return null;
  const snooze = row.status === 'snoozed' && row.snoozed_until ? Date.parse(row.snoozed_until) : NaN;
  return new Date(Number.isFinite(snooze) ? Math.max(start, snooze) : start).toISOString();
}
