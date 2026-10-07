// lib/calendar/event-range.ts — the "when" line of an event's detail.
//
// A timed event is two instants and reads on the family's clock, through the
// shared formatter bound to their zone (TIME-003). An all-day event is a DATE
// stored as an instant on that date in UTC (lib/calendar/day.ts); formatting
// that instant in the family's zone drew a Saturday birthday as "Friday" in Los
// Angeles. So an all-day row is formatted as the date it is — handed to the
// formatter as `YYYY-MM-DD`, which it renders without converting through any
// zone — and a row whose exclusive end is past its next date names its last
// date too.
import type { Format } from '@/lib/utils/format';
import { addDays, allDayDate } from '@/lib/calendar/day';

export type RangeEvent = { starts_at: string; ends_at: string | null; all_day: boolean | null };

const DATE_PATTERN = 'EEEE, MMMM d';

/** "Saturday, October 10 · 4:00 PM – 5:00 PM", or "Saturday, October 10 · All day". */
export function formatEventRange(
  e: RangeEvent,
  { fmtDate, fmtTime }: Pick<Format, 'fmtDate' | 'fmtTime'>,
  allDayLabel = 'All day',
): string {
  if (e.all_day) {
    const first = allDayDate(e.starts_at);
    if (!first) return allDayLabel;
    // An all-day end is exclusive (an ICS DTEND;VALUE=DATE, a provider's next
    // midnight): the last date ON is the one before it.
    const endDate = e.ends_at ? allDayDate(e.ends_at) : '';
    const last = endDate && endDate > addDays(first, 1) ? addDays(endDate, -1) : first;
    const dates = last === first ? fmtDate(first, DATE_PATTERN) : `${fmtDate(first, DATE_PATTERN)} – ${fmtDate(last, DATE_PATTERN)}`;
    return `${dates} · ${allDayLabel}`;
  }
  const date = fmtDate(e.starts_at, DATE_PATTERN);
  const time = fmtTime(e.starts_at) + (e.ends_at ? ` – ${fmtTime(e.ends_at)}` : '');
  return `${date} · ${time}`;
}
