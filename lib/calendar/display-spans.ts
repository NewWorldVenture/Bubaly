import type { CalendarDisplayOccurrence } from './display-occurrences';
import { addDays } from './day';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';

/** A rendered segment keeps the complete original occurrence for every action.
 * Segment dates/times are layout metadata, never new calendar identities. */
export type CalendarDisplaySpan = {
  occurrence: CalendarDisplayOccurrence; day: string; segmentKey: string;
  actualStartsAt: string; actualEndsAt: string;
  dayStartsAt: string; dayEndsAt: string; dayMinutes: number;
  elapsedStartMinutes: number; elapsedEndMinutes: number;
};

function validDate(day:string):boolean {
  const instant=Date.parse(`${day}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(instant) && new Date(instant).toISOString().slice(0,10)===day;
}
export function calendarDisplayDay(day: string, timezone: string) {
  if (!validDate(day)) throw new Error('Invalid calendar day');
  if (typeof timezone !== 'string' || !timezone.trim()) throw new Error('Invalid calendar timezone');
  const bounds = briefingCalendarBounds(day, timezone, 0, 1);
  const start = Date.parse(bounds.timedFrom), end = Date.parse(bounds.timedTo);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Invalid calendar day interval');
  return { start, end, minutes: (end - start) / 60_000 };
}

/** Civil DATEs occupy every date before their exclusive end. Timed intervals
 * occupy their actual overlap with each family day, including 23/25-hour days.
 * An explicit point occupies only the date of its instant, with zero duration. */
export function bucketCalendarDisplaySpans(occurrences: readonly CalendarDisplayOccurrence[], fromDay: string, toDay: string, timezone: string): Map<string, CalendarDisplaySpan[]> {
  if (!validDate(fromDay) || !validDate(toDay) || fromDay > toDay || occurrences.length > 20_000) throw new Error('Invalid calendar display window');
  if (typeof timezone !== 'string' || !timezone.trim()) throw new Error('Invalid calendar timezone');
  // Empty windows still validate their zone; no device-zone fallback.
  new Intl.DateTimeFormat('en-US',{timeZone:timezone});
  const days: { day:string; start:number; end:number; minutes:number }[] = [];
  for (let day = fromDay; day < toDay; day = addDays(day, 1)) {
    if (days.length >= 366 || !day || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) throw new Error('Invalid calendar display window');
    days.push({day,...calendarDisplayDay(day,timezone)});
  }
  const buckets = new Map<string,CalendarDisplaySpan[]>();
  for (const item of days) buckets.set(item.day,[]);
  let total = 0;
  for (const occurrence of occurrences) {
    const start = Date.parse(occurrence.actualStartsAt);
    const end = occurrence.actualEndsAt === null ? start + (occurrence.kind === 'native' ? 3_600_000 : 0) : Date.parse(occurrence.actualEndsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Invalid calendar display interval');
    const dateStart = occurrence.startDate ?? occurrence.starts_at.slice(0,10);
    const dateEnd = occurrence.endDate ?? addDays(dateStart,1);
    if (occurrence.all_day) {
      if (dateEnd <= dateStart) throw new Error('Invalid calendar DATE interval');
      // Validate the complete civil endpoints, even if outside the visible grid.
      if (!validDate(dateStart) || !validDate(dateEnd)) throw new Error('Invalid calendar DATE interval');
    }
    for (const item of days) {
      // A vanished civil date still has DATE annotations, but no instant can
      // occupy its zero-length timed timeline.
      if (!occurrence.all_day && item.end === item.start) continue;
      const occupied = occurrence.all_day ? dateStart <= item.day && item.day < dateEnd
        : start < item.end && (end > item.start || end === start && start >= item.start);
      if (!occupied) continue;
      if (++total > 1_000_000) throw new Error('Calendar display span bound exhausted');
      const clippedStart = occurrence.all_day ? item.start : Math.max(start,item.start);
      const clippedEnd = occurrence.all_day ? item.end : Math.min(end,item.end);
      buckets.get(item.day)!.push({occurrence,day:item.day,segmentKey:JSON.stringify([occurrence.occurrenceKey,item.day]),
        actualStartsAt:new Date(clippedStart).toISOString(),actualEndsAt:new Date(clippedEnd).toISOString(),
        dayStartsAt:new Date(item.start).toISOString(),dayEndsAt:new Date(item.end).toISOString(),dayMinutes:item.minutes,
        elapsedStartMinutes:(clippedStart-item.start)/60_000,elapsedEndMinutes:(clippedEnd-item.start)/60_000});
    }
  }
  for (const spans of buckets.values()) spans.sort((a,b)=>Number(b.occurrence.all_day)-Number(a.occurrence.all_day)
    || a.elapsedStartMinutes-b.elapsedStartMinutes || a.occurrence.occurrenceKey.localeCompare(b.occurrence.occurrenceKey));
  return buckets;
}
