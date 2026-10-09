import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { dayKeyIn } from '@/lib/time/zoned';

type CalendarDateEvent = { starts_at: string; ends_at?: string | null; all_day?: boolean | null };

/** All-day rows store a calendar date as UTC midnight; timed rows store an instant. */
export function calendarEventDayKey(event: CalendarDateEvent, timezone: string): string {
  const start = new Date(event.starts_at);
  return event.all_day ? start.toISOString().slice(0, 10) : dayKeyIn(start, timezone);
}

/** Resolve stored DATE boundaries on the family's clock, including 23/25-hour days. */
export function allDayBusyInterval(event: CalendarDateEvent, timezone: string): { start: number; end: number } {
  const day = calendarEventDayKey({ ...event, all_day: true }, timezone);
  const first = Date.parse(`${day}T00:00:00Z`);
  const endInstant = event.ends_at ? new Date(event.ends_at) : null;
  const endDate = endInstant && Number.isFinite(endInstant.getTime()) ? endInstant.toISOString().slice(0, 10) : null;
  const end = endDate ? Date.parse(`${endDate}T00:00:00Z`) : first;
  const days = Math.max(1, (end - first) / 86_400_000);
  const bounds = briefingCalendarBounds(day, timezone, 0, days);
  return { start: Date.parse(bounds.timedFrom), end: Date.parse(bounds.timedTo) };
}
