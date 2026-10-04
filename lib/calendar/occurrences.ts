// lib/calendar/occurrences.ts — what is ON the calendar in a window, series
// included.
//
// `calendar_events` stores a recurring event as ONE row whose `starts_at` is
// its first occurrence. Every surface that read "today's events" or "this
// week's events" filtered that column by the window — the daily brief, the
// weekly brief, the weekly digest email, the pushed morning brief — so a weekly
// practice created in August was in the brief the week it was created and in
// no brief after that. The calendar page itself expands series
// (lib/calendar/recurrence.ts); the briefs did not.
//
// This is the one read those surfaces share. One-off rows are read by the
// window as before (timed rows by family-local instants, all-day rows by their
// stored date, lib/briefing/calendar-window.ts); series rows that could reach
// the window are read whole and expanded with the same expander the calendar
// page uses, timed series in the family's zone and all-day series by date.
// The caller's `limit` applies to the merged, sorted result, so eight slots of
// "coming up" are the eight nearest things, not the eight nearest rows.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { expandEventsInZone } from '@/lib/calendar/recurrence';
import { calendarWindowFilter, type CalendarWindowBounds } from '@/lib/briefing/calendar-window';

type EventRow = Database['public']['Tables']['calendar_events']['Row'];
type Db = SupabaseClient<Database>;

/** The columns the expander needs; always read, whatever the caller asked for. */
const RECURRENCE_COLUMNS = ['id', 'starts_at', 'ends_at', 'all_day', 'recurrence', 'recurrence_until'] as const;
type RecurrenceColumn = (typeof RECURRENCE_COLUMNS)[number];

/** A row as the caller asked for it, plus the recurrence columns, with `starts_at`/`ends_at` of THIS occurrence. */
export type CalendarOccurrence<C extends keyof EventRow> = Pick<EventRow, C | RecurrenceColumn>;

export type OccurrencesResult<C extends keyof EventRow> =
  | { data: CalendarOccurrence<C>[]; error: null }
  | { data: null; error: { message: string } };

/** More series than a household could have; a read past it is a failed read, never a silent prefix. */
const SERIES_READ_MAX = 2000;

const isSeries = (row: { recurrence: string | null }) => !!row.recurrence && row.recurrence !== 'none';

const earlier = (a: string, b: string) => (a < b ? a : b);
const later = (a: string, b: string) => (a > b ? a : b);

/**
 * Every occurrence in the window, in `starts_at` order.
 *
 * Two reads, both scoped to the family: the one-off rows the window filter
 * selects (series excluded, or a master whose first occurrence falls in the
 * window would appear twice), and every series row that could reach the window
 * — started before its end, not ended before its start — expanded here. A
 * failed read is returned as the error it was, so a caller that treats an
 * unreadable calendar as "unavailable, never an empty day" still can.
 */
export async function readCalendarOccurrences<C extends keyof EventRow>(
  db: Db,
  familyId: string,
  bounds: CalendarWindowBounds,
  timezone: string,
  opts: { columns: readonly C[]; limit?: number },
): Promise<OccurrencesResult<C>> {
  const columns = [...new Set<string>([...opts.columns, ...RECURRENCE_COLUMNS])].join(', ');
  const dayStart = `${bounds.allDayFromDay}T00:00:00.000Z`;
  const dayEnd = `${bounds.allDayToDay}T00:00:00.000Z`;

  // The one-offs: the window filter, series excluded (a master whose first
  // occurrence falls in the window is the series read's to produce, once).
  const singles = await db
    .from('calendar_events')
    .select(columns)
    .eq('family_id', familyId)
    .or(calendarWindowFilter(bounds))
    .or('recurrence.is.null,recurrence.eq.none')
    .order('starts_at');
  if (singles.error) return { data: null, error: singles.error };

  // Every series that could reach the window: started by its end, not ended
  // before its start. `neq` excludes a null recurrence as SQL does. One row past
  // the ceiling is read so a household past it is a failed read, not a prefix.
  const latest = later(bounds.timedTo, dayEnd);
  const earliest = earlier(bounds.timedFrom, dayStart);
  const series = await db
    .from('calendar_events')
    .select(columns)
    .eq('family_id', familyId)
    .neq('recurrence', 'none')
    .lte('starts_at', latest)
    .or(`recurrence_until.is.null,recurrence_until.gte.${earliest}`)
    .order('starts_at')
    .limit(SERIES_READ_MAX + 1);
  if (series.error) return { data: null, error: series.error };
  const seriesRows = ((series.data ?? []) as unknown as CalendarOccurrence<C>[]).filter(isSeries);
  if (seriesRows.length > SERIES_READ_MAX) return { data: null, error: { message: `More than ${SERIES_READ_MAX} recurring events; the window cannot be read whole` } };

  const timed = seriesRows.filter((row) => !row.all_day);
  const allDay = seriesRows.filter((row) => row.all_day);
  const occurrences = [
    ...expandEventsInZone(timed, new Date(bounds.timedFrom), new Date(bounds.timedTo), timezone),
    // An all-day series steps by calendar date; its rows are UTC midnights of
    // the family's dates, so the date window and a UTC clock read them as written.
    ...expandEventsInZone(allDay, new Date(dayStart), new Date(dayEnd), 'UTC'),
  ];

  // Both lists are filtered here as well as in the query, so a row the database
  // (or a stand-in for it) answers out of place is still counted once.
  const singleRows = ((singles.data ?? []) as unknown as CalendarOccurrence<C>[]).filter((row) => !isSeries(row));
  const rows = [...singleRows, ...occurrences]
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || String(a.id).localeCompare(String(b.id)));
  return { data: opts.limit !== undefined ? rows.slice(0, opts.limit) : rows, error: null };
}
