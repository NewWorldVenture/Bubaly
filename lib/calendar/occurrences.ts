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
import { calendarOverlapWindowFilter, calendarWindowFilter, type CalendarWindowBounds } from '@/lib/briefing/calendar-window';
import { CALENDAR_SOURCE_ARCHIVE_ENABLED } from './source-capability';

type EventRow = Database['public']['Tables']['calendar_events']['Row'];
type Db = SupabaseClient<Database>;

/** The columns the expander needs; always read, whatever the caller asked for. */
const RECURRENCE_COLUMNS = ['id', 'starts_at', 'ends_at', 'all_day', 'recurrence', 'recurrence_until'] as const;
type RecurrenceColumn = (typeof RECURRENCE_COLUMNS)[number];

/** A row as the caller asked for it, plus the recurrence columns, with `starts_at`/`ends_at` of THIS occurrence. */
export type CalendarOccurrence<C extends keyof EventRow> = Pick<EventRow, C | RecurrenceColumn>;

export type OccurrencesResult<C extends keyof EventRow> =
  /** `count` is every occurrence in the window, before `limit`: the number a badge shows beside a list that is cut. */
  | { data: CalendarOccurrence<C>[]; count: number; error: null }
  | { data: null; count: null; error: { message: string } };

export type OccurrenceFilters = {
  eq(column: string, value: unknown): OccurrenceFilters;
  neq(column: string, value: unknown): OccurrenceFilters;
  in(column: string, values: readonly unknown[]): OccurrenceFilters;
  ilike(column: string, pattern: string): OccurrenceFilters;
  not(column: string, operator: string, value: unknown): OccurrenceFilters;
};

export type OccurrencesOptions<C extends keyof EventRow> = {
  signal?: AbortSignal;
  /** Qualify each fetched native row before filtering or expanding masters. */
  validateRow?: (row: CalendarOccurrence<C>) => void;
  columns?: readonly C[];
  /** Applied after the merge, to the sorted occurrences. */
  limit?: number;
  /** Read the first N singles completely even when the server's cap is lower. Count is a floor in this mode. */
  singlesLimit?: number;
  refine?: (query: OccurrenceFilters) => OccurrenceFilters;
  /** Include intervals that started before the window and still occupy it. */
  overlap?: boolean;
  /** Only this member's events (the digital twin reads one person's load). */
  assigneeId?: string;
  /**
   * The PostgREST OR filter for the one-off rows, when the window's own
   * (`calendarWindowFilter`) is not the right one — the kitchen display reads
   * events that OVERLAP the window, not only those that start in it.
   */
  singlesFilter?: string;
};

/** More series than a household could have; a read past it is a failed read, never a silent prefix. */
const SERIES_READ_MAX = 2000;
const SINGLE_READ_MAX = 20_000;
const READ_PAGE = 1000;

type PageResult = { data: unknown[] | null; count: number | null; error: { message: string } | null };

/** Exact counts distinguish a complete collection from a server-capped page. */
export async function readCountedRows<T = unknown>(
  first: () => PromiseLike<PageResult>,
  more: (from: number, to: number) => PromiseLike<PageResult>,
  max: number,
  label: string,
  take?: number,
): Promise<{ data: T[] | null; error: { message: string } | null }> {
  const fail = (reason: string) => ({ data: null, error: { message: `${reason}; the calendar window cannot be read whole` } });
  const rows: T[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  let target = 0;
  try {
    for (;;) {
      const result = await (rows.length === 0 ? first() : more(rows.length, Math.min(rows.length + READ_PAGE, target) - 1));
      if (result.error) return { data: null, error: result.error };
      if (typeof result.count !== 'number' || !Number.isSafeInteger(result.count) || result.count < 0) {
        return fail(`No usable count of ${label}`);
      }
      if (total === null) total = result.count;
      else if (result.count !== total) return fail(`The count of ${label} changed from ${total} to ${result.count}`);
      target = take === undefined ? total : Math.min(total, take);
      if (target > max) return fail(`More than ${max} ${label}`);
      if (!Array.isArray(result.data)) return fail(`The ${label} page was unavailable`);
      for (const row of result.data) {
        const id = row && typeof row === 'object' && 'id' in row ? row.id : null;
        if (typeof id !== 'string' || !id) return fail(`A ${label} row had no identity`);
        if (seen.has(id)) return fail(`The ${label} read repeated row ${id}`);
        seen.add(id);
        rows.push(row as T);
      }
      if (rows.length > target) return fail(`The ${label} read answered more rows than it counted or requested`);
      if (rows.length === target) return { data: rows, error: null };
      if (result.data.length === 0) return fail(`The ${label} read stopped at ${rows.length} of ${target} rows`);
    }
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause));
  }
}

export const isSeries = (row: { recurrence: string | null }) => !!row.recurrence && row.recurrence !== 'none';

const earlier = (a: string, b: string) => (a < b ? a : b);
const later = (a: string, b: string) => (a > b ? a : b);

export type CalendarBusyOccurrence = { id: string; starts_at: string; ends_at: string | null; member_id: string | null };
type SportsBusyRow = CalendarBusyOccurrence & { recurrence: string; recurrence_until: string | null };
type BusyResult = { data: CalendarBusyOccurrence[] | null; error: { message: string } | null };

/** Complete occupied intervals, including older sports masters stepped in the family's zone. */
export async function readCalendarBusySource(
  db: Db, familyId: string, table: 'school_events' | 'sports_events', from: string, to: string, timezone: string,
): Promise<BusyResult> {
  const fail = (reason: string): BusyResult => ({ data: null, error: { message: `${reason}; the calendar window cannot be read whole` } });
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return fail('Invalid busy window');
  if (typeof timezone !== 'string' || !timezone.trim()) return fail('Invalid family timezone');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(fromMs); }
  catch { return fail('Invalid family timezone'); }
  if (fromMs === toMs) return { data: [], error: null };
  const fallbackFrom = new Date(fromMs - 3_600_000).toISOString();
  // Starts at the boundary include explicit points. An earlier point occupies
  // nothing; a missing end keeps the established one-hour estimate.
  const overlapFilter = `starts_at.gte.${from},ends_at.gt.${from},and(ends_at.is.null,starts_at.gt.${fallbackFrom})`;
  const singlesQuery = () => {
    if (table === 'school_events') return db.from('school_events')
      .select('id, starts_at, ends_at, member_id', { count: 'exact' })
      .eq('family_id', familyId).lt('starts_at', to).or(overlapFilter)
      .order('starts_at').order('id');
    return db.from('sports_events').select('id, starts_at, ends_at, member_id', { count: 'exact' })
      .eq('family_id', familyId).lt('starts_at', to).or(overlapFilter)
      .or('recurrence.is.null,recurrence.eq.none').order('starts_at').order('id');
  };
  const seriesQuery = () => db.from('sports_events')
    .select('id, starts_at, ends_at, member_id, recurrence, recurrence_until', { count: 'exact' })
    .eq('family_id', familyId).neq('recurrence', 'none').lt('starts_at', to)
    // Do not compare the cutoff with `from`: the last valid occurrence can
    // still overlap this window after its exclusive recurrence cutoff.
    .order('starts_at').order('id');
  const [singles, series] = await Promise.all([
    readCountedRows<CalendarBusyOccurrence>(() => singlesQuery().limit(READ_PAGE), (first, last) => singlesQuery().range(first, last), SINGLE_READ_MAX, `${table} one-off busy events`),
    table === 'sports_events'
      ? readCountedRows<SportsBusyRow>(() => seriesQuery().limit(READ_PAGE), (first, last) => seriesQuery().range(first, last), SERIES_READ_MAX, 'recurring sports events')
      : Promise.resolve({ data: [] as SportsBusyRow[], error: null }),
  ]);
  if (singles.error) return { data: null, error: singles.error };
  if (series.error) return { data: null, error: series.error };
  try {
    const validInterval = (row: CalendarBusyOccurrence) => {
      const start = Date.parse(row.starts_at), end = row.ends_at === null ? start + 3_600_000 : Date.parse(row.ends_at);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new RangeError('Invalid busy interval');
      return { start, end };
    };
    const rows = (singles.data ?? []).filter(row => {
      const { start, end } = validInterval(row);
      return start < toMs && (end > start ? end > fromMs : start >= fromMs);
    });
    for (const master of (series.data ?? []).filter(isSeries)) {
      validInterval(master);
      rows.push(...expandEventsInZone([master], new Date(fromMs), new Date(toMs), timezone, true, { requireComplete: true }));
      if (rows.length > SINGLE_READ_MAX) return fail(`More than ${SINGLE_READ_MAX} busy occurrences`);
    }
    return { data: rows.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id)), error: null };
  } catch (cause) { return fail(cause instanceof Error ? cause.message : 'Invalid busy recurrence'); }
}

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
export async function readCalendarOccurrences<C extends keyof EventRow = keyof EventRow>(
  db: Db,
  familyId: string,
  bounds: CalendarWindowBounds,
  timezone: string,
  opts: OccurrencesOptions<C> = {},
): Promise<OccurrencesResult<C>> {
  if (CALENDAR_SOURCE_ARCHIVE_ENABLED) {
    return { data: null, count: null, error: { message: 'This calendar read is unavailable. Please try again later.' } };
  }
  for (const limit of [opts.limit, opts.singlesLimit]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      return { data: null, count: null, error: { message: 'Invalid calendar read limit' } };
    }
  }
  if (opts.signal?.aborted) return { data: null, count: null, error: { message: 'Calendar request aborted' } };
  const columns = opts.columns ? [...new Set<string>([...opts.columns, ...RECURRENCE_COLUMNS])].join(', ') : '*';
  const dayStart = `${bounds.allDayFromDay}T00:00:00.000Z`;
  const dayEnd = `${bounds.allDayToDay}T00:00:00.000Z`;
  const scoped = <Q extends { eq: (column: string, value: string) => Q }>(query: Q): Q => {
    const own = opts.assigneeId ? query.eq('assignee_id', opts.assigneeId) : query;
    return opts.refine ? opts.refine(own as unknown as OccurrenceFilters) as unknown as Q : own;
  };

  // Two reads, issued together and awaited together: the one-offs by the
  // window filter, series excluded (a master whose first occurrence falls in
  // the window is the series read's to produce, once); and every series that
  // could reach the window — started by its end, not ended before its start.
  // `neq` excludes a null recurrence as SQL does. Count each collection and
  // page by rows actually received, including a unique ID to break start ties.
  const latest = later(bounds.timedTo, dayEnd);
  const earliest = earlier(bounds.timedFrom, dayStart);
  const singlesQuery = () => {
    const query = scoped(db
    .from('calendar_events')
    .select(columns, { count: 'exact' })
    .eq('family_id', familyId))
    .or(opts.singlesFilter ?? (opts.overlap ? calendarOverlapWindowFilter(bounds) : calendarWindowFilter(bounds)))
    .or('recurrence.is.null,recurrence.eq.none')
    .order('starts_at').order('id');
    return opts.signal ? query.abortSignal(opts.signal) : query;
  };
  const seriesQuery = () => {
    let query = scoped(db
    .from('calendar_events')
    .select(columns, { count: 'exact' })
    .eq('family_id', familyId))
    .neq('recurrence', 'none')
    .lte('starts_at', latest);
    if (!opts.overlap) query = query.or(`recurrence_until.is.null,recurrence_until.gte.${earliest}`);
    const ordered = query.order('starts_at').order('id');
    return opts.signal ? ordered.abortSignal(opts.signal) : ordered;
  };
  const [singles, series] = await Promise.all([
    readCountedRows(() => singlesQuery().limit(Math.min(READ_PAGE, opts.singlesLimit ?? READ_PAGE)), (from, to) => singlesQuery().range(from, to), SINGLE_READ_MAX, 'one-off events', opts.singlesLimit),
    readCountedRows(() => seriesQuery().limit(READ_PAGE), (from, to) => seriesQuery().range(from, to), SERIES_READ_MAX, 'recurring events'),
  ]);
  if (singles.error) return { data: null, count: null, error: singles.error };
  if (series.error) return { data: null, count: null, error: series.error };
  if (opts.signal?.aborted) return { data: null, count: null, error: { message: 'Calendar request aborted' } };
  try {
    for (const row of (singles.data ?? []) as unknown as CalendarOccurrence<C>[]) opts.validateRow?.(row);
    for (const row of (series.data ?? []) as unknown as CalendarOccurrence<C>[]) opts.validateRow?.(row);
  } catch (cause) {
    return { data: null, count: null, error: { message: cause instanceof Error ? cause.message : 'Invalid native calendar row' } };
  }
  if (opts.signal?.aborted) return { data: null, count: null, error: { message: 'Calendar request aborted' } };
  const seriesRows = ((series.data ?? []) as unknown as CalendarOccurrence<C>[]).filter(isSeries);
  if (seriesRows.length > SERIES_READ_MAX) return { data: null, count: null, error: { message: `More than ${SERIES_READ_MAX} recurring events; the window cannot be read whole` } };

  const timed = seriesRows.filter((row) => !row.all_day);
  const allDay = seriesRows.filter((row) => row.all_day);
  let occurrences: CalendarOccurrence<C>[];
  try {
    occurrences = [
    ...expandEventsInZone(timed, new Date(bounds.timedFrom), new Date(bounds.timedTo), timezone, opts.overlap, { requireComplete: true }),
    // An all-day series steps by calendar date; its rows are UTC midnights of
    // the family's dates, so the date window and a UTC clock read them as written.
    ...expandEventsInZone(allDay, new Date(dayStart), new Date(dayEnd), 'UTC', opts.overlap, { requireComplete: true }),
    ];
  } catch (cause) {
    return { data: null, count: null, error: { message: cause instanceof Error ? cause.message : 'The calendar window cannot be read whole' } };
  }

  // Both lists are filtered here as well as in the query, so a row the database
  // (or a stand-in for it) answers out of place is still counted once.
  const singleRows = ((singles.data ?? []) as unknown as CalendarOccurrence<C>[]).filter((row) => !isSeries(row));
  const rows = [...singleRows, ...occurrences]
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || String(a.id).localeCompare(String(b.id)));
  if (opts.signal?.aborted) return { data: null, count: null, error: { message: 'Calendar request aborted' } };
  return { data: opts.limit !== undefined ? rows.slice(0, opts.limit) : rows, count: rows.length, error: null };
}
