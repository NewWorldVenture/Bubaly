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
//
// The planner's reads go through here too: the calendar service's search (and
// so the assistant's calendar tools, the schedule slice and the trip planner),
// the free-slot finder, the busy-evenings check, the reminder engine's 48-hour
// and conflict sweeps, and the readiness page. Each of them used to filter
// `starts_at` by its window as well, so a weekly practice was invisible to all
// of them from its second week: the planner double-booked over it, no reminder
// fired for it, and the free-slot finder offered its hour.
//
// `sports_events` (0006) is the one other household table with a recurrence
// rule, and weekly practice is exactly the row a family enters once. The same
// core reads it (`readSportsOccurrences`): its rows are all timed, so its
// window is the instant window alone.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { expandEventsInZone } from '@/lib/calendar/recurrence';
import { calendarWindowFilter, type CalendarWindowBounds } from '@/lib/briefing/calendar-window';

type EventRow = Database['public']['Tables']['calendar_events']['Row'];
type SportsRow = Database['public']['Tables']['sports_events']['Row'];
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

/**
 * The filters a caller may add to BOTH reads (a category, a title match, an
 * assignee that must be set). Each returns the builder it was given, as the
 * PostgREST builder does; the shape is structural so a caller is not tied to
 * the client library's generics for a read whose select list is built here.
 */
export type OccurrenceFilters = {
  eq(column: string, value: unknown): OccurrenceFilters;
  neq(column: string, value: unknown): OccurrenceFilters;
  in(column: string, values: readonly unknown[]): OccurrenceFilters;
  ilike(column: string, pattern: string): OccurrenceFilters;
  is(column: string, value: boolean | null): OccurrenceFilters;
  not(column: string, operator: string, value: unknown): OccurrenceFilters;
};

export type OccurrencesOptions<C extends keyof EventRow> = {
  /** The columns to read; omitted reads every column. The recurrence columns are always read. */
  columns?: readonly C[];
  /** Applied after the merge, to the sorted occurrences. */
  limit?: number;
  /**
   * A database-side cap on the ONE-OFF read, for a caller that wants the
   * nearest `limit` things and not a count: the merged first `limit` can only
   * draw on the first `limit` one-offs by start. `count` is then a floor, not
   * the window's total.
   */
  singlesLimit?: number;
  /** Only this member's events (the digital twin reads one person's load). */
  assigneeId?: string;
  /**
   * The PostgREST OR filter for the one-off rows, when the window's own
   * (`calendarWindowFilter`) is not the right one — the kitchen display reads
   * events that OVERLAP the window, not only those that start in it; the
   * calendar search with no end reads every one-off from the start on.
   */
  singlesFilter?: string;
  /** Filters added to both reads — a category, a title match. */
  refine?: (query: OccurrenceFilters) => OccurrenceFilters;
};

/** More series than a household could have; a window past it is a failed read, never a silent prefix. */
const SERIES_READ_MAX = 2000;

/**
 * PostgREST's `db-max-rows` caps ONE response — 1,000 rows on a hosted Supabase
 * project, and this repository sets no override — and does so silently: a
 * 1,001-row answer arrives as 1,000 rows and no error. So neither read here
 * trusts a single response. Each asks for an exact count; the first request is
 * unbounded (one request answers a household under the cap, as before), and
 * when the server answered fewer rows than it counted the read goes on with
 * `.range()` from where the answer stopped, in pages of READ_PAGE, until the
 * count is reached.
 *
 * The count is the only thing that tells a whole answer from a cut one, so it
 * is held to what a count can be: a safe non-negative integer, the same on
 * every page. An answer without one (a missing or unparsable Content-Range,
 * which supabase-js reports as `count: null` with no error), a count that
 * changes between pages (rows added or removed under the read, so offsets no
 * longer mean what they did), a page that adds nothing or repeats rows already
 * read, or more rows than were counted — each is a FAILED read, never a prefix
 * that passes for the whole window. Before this, the series read asked for
 * 2,001 rows and called only an answer above 2,000 oversized, so a household
 * with 1,001–2,000 series read as its first 1,000. (Review 5981467603 and the
 * recheck 5981632558 on #923.)
 */
const READ_PAGE = 1000;

type PageResult = { data: unknown[] | null; error: { message: string } | null; count?: unknown };

/** What a count can be: a safe non-negative integer. `null`, NaN, a fraction or a negative are not counts. */
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

async function readPaged<T extends { id: unknown }>(
  whole: () => PromiseLike<PageResult>,
  more: (from: number, to: number) => PromiseLike<PageResult>,
  max: number,
  what: string,
): Promise<{ rows: T[]; error: null } | { rows: null; error: { message: string } }> {
  const refuse = (message: string) => ({ rows: null, error: { message: `${message}; the window cannot be read whole` } }) as const;
  const rows: T[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  for (;;) {
    const res = await (rows.length === 0 ? whole() : more(rows.length, rows.length + READ_PAGE - 1));
    if (res.error) return { rows: null, error: res.error };
    if (!isCount(res.count)) return refuse(`The database answered without a usable count of the ${what} (${String(res.count)})`);
    if (total === null) total = res.count;
    else if (res.count !== total) return refuse(`The count of ${what} changed from ${total} to ${res.count} while the window was being read`);
    if (total > max) return refuse(`More than ${max} ${what}`);
    let added = 0;
    const page = new Set<string>();
    for (const r of (res.data ?? []) as T[]) {
      // A row an EARLIER page already answered is the server repeating itself
      // (an offset it ignored), not a new row; within one page every row is
      // taken as it came. A row without an id cannot be recognised as a repeat.
      const key = r.id == null ? null : String(r.id);
      if (key !== null) {
        if (seen.has(key)) continue;
        page.add(key);
      }
      rows.push(r);
      added += 1;
    }
    for (const key of page) seen.add(key);
    if (rows.length > total) return refuse(`The database answered ${rows.length} ${what} but counted ${total}`);
    if (rows.length === total) break;
    if (added === 0) return refuse(`The database answered ${rows.length} of the ${total} ${what} it counted`);
  }
  return { rows, error: null };
}

/** A row that stands for a series: one record, an occurrence per step. */
export const isSeries = (row: { recurrence: string | null }): boolean => !!row.recurrence && row.recurrence !== 'none';

const earlier = (a: string, b: string) => (a < b ? a : b);
const later = (a: string, b: string) => (a > b ? a : b);

/** The builder the core drives: a `select` already applied, the rest added here. */
type WindowQuery = PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }> & {
  eq(column: string, value: string): WindowQuery;
  neq(column: string, value: string): WindowQuery;
  lte(column: string, value: string): WindowQuery;
  or(filter: string): WindowQuery;
  order(column: string): WindowQuery;
  limit(count: number): WindowQuery;
  range(from: number, to: number): WindowQuery;
};

type WindowRow = { id: string; starts_at: string; recurrence: string | null };

type WindowReads<R> = { singles: R[]; series: R[]; error: null } | { singles: null; series: null; error: { message: string } };

/**
 * The two reads every series-aware window shares, issued together and awaited
 * together: the one-off rows the window filter selects (series excluded, or a
 * master whose first occurrence falls in the window would appear twice), and
 * every series row that could reach the window — started by `latest`, not
 * ended before `earliest`. `neq` excludes a null recurrence as SQL does. Each
 * read is checked against its exact count and paged when the answer was cut
 * (see READ_PAGE); the `select` the caller hands in must ask for that count, and
 * the order carries `id` as a tiebreaker so pages do not overlap on equal starts. Both lists are filtered here as well
 * as in the query, so a row the database (or a stand-in for it) answers out of
 * place is still counted once.
 */
async function readWindowRows<R extends WindowRow>(args: {
  select: () => WindowQuery;
  familyId: string;
  singlesFilter: string;
  latest: string;
  earliest: string;
  scope?: { column: string; value: string };
  refine?: (query: OccurrenceFilters) => OccurrenceFilters;
  singlesLimit?: number;
}): Promise<WindowReads<R>> {
  // The caller's filters, on both reads. The builder returns itself from every
  // filter, so the structural view and the typed builder are the same object.
  const scoped = (query: WindowQuery): WindowQuery => {
    const own = args.scope ? query.eq(args.scope.column, args.scope.value) : query;
    return args.refine ? (args.refine(own as unknown as OccurrenceFilters) as unknown as WindowQuery) : own;
  };
  const singlesBase = () => scoped(args.select().eq('family_id', args.familyId))
    .or(args.singlesFilter)
    .or('recurrence.is.null,recurrence.eq.none')
    .order('starts_at')
    .order('id');
  const seriesBase = () => scoped(args.select().eq('family_id', args.familyId))
    .neq('recurrence', 'none')
    .lte('starts_at', args.latest)
    .or(`recurrence_until.is.null,recurrence_until.gte.${args.earliest}`)
    .order('starts_at')
    .order('id');
  // A caller that wants the nearest `singlesLimit` one-offs asks for exactly
  // that many; everything else is read whole.
  const singlesRead: Promise<{ rows: R[]; error: null } | { rows: null; error: { message: string } }> =
    args.singlesLimit !== undefined
      ? Promise.resolve(singlesBase().limit(args.singlesLimit)).then((r) => (r.error ? { rows: null, error: r.error } : { rows: (r.data ?? []) as R[], error: null }))
      : readPaged<R>(() => singlesBase() as unknown as PromiseLike<PageResult>, (from, to) => singlesBase().range(from, to) as unknown as PromiseLike<PageResult>, Number.POSITIVE_INFINITY, 'one-off events');
  const seriesRead = readPaged<R>(() => seriesBase() as unknown as PromiseLike<PageResult>, (from, to) => seriesBase().range(from, to) as unknown as PromiseLike<PageResult>, SERIES_READ_MAX, 'recurring events');
  const [singles, series] = await Promise.all([singlesRead, seriesRead]);
  if (singles.error) return { singles: null, series: null, error: singles.error };
  if (series.error) return { singles: null, series: null, error: series.error };
  return { singles: singles.rows.filter((row) => !isSeries(row)), series: series.rows.filter(isSeries), error: null };
}

/** One-offs and occurrences together, in `starts_at` order, cut at `limit`; `count` is the total before the cut. */
function mergeOccurrences<R extends WindowRow>(singles: R[], occurrences: R[], limit: number | undefined) {
  const rows = [...singles, ...occurrences]
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || String(a.id).localeCompare(String(b.id)));
  return { data: limit !== undefined ? rows.slice(0, limit) : rows, count: rows.length, error: null as null };
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
  const columns = opts.columns ? [...new Set<string>([...opts.columns, ...RECURRENCE_COLUMNS])].join(', ') : '*';
  const dayStart = `${bounds.allDayFromDay}T00:00:00.000Z`;
  const dayEnd = `${bounds.allDayToDay}T00:00:00.000Z`;
  const read = await readWindowRows<CalendarOccurrence<C>>({
    select: () => db.from('calendar_events').select(columns, { count: 'exact' }) as unknown as WindowQuery,
    familyId,
    singlesFilter: opts.singlesFilter ?? calendarWindowFilter(bounds),
    latest: later(bounds.timedTo, dayEnd),
    earliest: earlier(bounds.timedFrom, dayStart),
    scope: opts.assigneeId ? { column: 'assignee_id', value: opts.assigneeId } : undefined,
    refine: opts.refine,
    singlesLimit: opts.singlesLimit,
  });
  if (read.error) return { data: null, count: null, error: read.error };

  const timed = read.series.filter((row) => !row.all_day);
  const allDay = read.series.filter((row) => row.all_day);
  const occurrences = [
    ...expandEventsInZone(timed, new Date(bounds.timedFrom), new Date(bounds.timedTo), timezone),
    // An all-day series steps by calendar date; its rows are UTC midnights of
    // the family's dates, so the date window and a UTC clock read them as written.
    ...expandEventsInZone(allDay, new Date(dayStart), new Date(dayEnd), 'UTC'),
  ];
  return mergeOccurrences(read.singles, occurrences, opts.limit);
}

// ── sports_events ────────────────────────────────────────────────────────────

/** The columns the expander needs from a sports row; always read. */
const SPORTS_RECURRENCE_COLUMNS = ['id', 'starts_at', 'ends_at', 'recurrence', 'recurrence_until'] as const;
type SportsRecurrenceColumn = (typeof SPORTS_RECURRENCE_COLUMNS)[number];

/** A sports row as the caller asked for it, plus the recurrence columns, with `starts_at`/`ends_at` of THIS occurrence. */
export type SportsOccurrence<C extends keyof SportsRow> = Pick<SportsRow, C | SportsRecurrenceColumn>;

export type SportsOccurrencesResult<C extends keyof SportsRow> =
  | { data: SportsOccurrence<C>[]; count: number; error: null }
  | { data: null; count: null; error: { message: string } };

export type SportsOccurrencesOptions<C extends keyof SportsRow> = {
  /** The columns to read; omitted reads every column. The recurrence columns are always read. */
  columns?: readonly C[];
  /** Applied after the merge, to the sorted occurrences. */
  limit?: number;
  /** A database-side cap on the one-off read; `count` is then a floor. */
  singlesLimit?: number;
  /** Only this member's practices and games. */
  memberId?: string;
  /** Filters added to both reads — an event type. */
  refine?: (query: OccurrenceFilters) => OccurrenceFilters;
};

/** The one-off filter for a table whose rows are all timed: the instant window, `timedTo` exclusive. */
export function timedWindowFilter(bounds: Pick<CalendarWindowBounds, 'timedFrom' | 'timedTo'>): string {
  return `and(starts_at.gte.${bounds.timedFrom},starts_at.lt.${bounds.timedTo})`;
}

/**
 * Every practice, game and tournament in the window, series expanded in the
 * family's zone, in `starts_at` order. Each occurrence keeps its source row's
 * id, which is what a planner needs to say "soccer is Tuesday at 5 again".
 */
export async function readSportsOccurrences<C extends keyof SportsRow = keyof SportsRow>(
  db: Db,
  familyId: string,
  bounds: Pick<CalendarWindowBounds, 'timedFrom' | 'timedTo'>,
  timezone: string,
  opts: SportsOccurrencesOptions<C> = {},
): Promise<SportsOccurrencesResult<C>> {
  const columns = opts.columns ? [...new Set<string>([...opts.columns, ...SPORTS_RECURRENCE_COLUMNS])].join(', ') : '*';
  const read = await readWindowRows<SportsOccurrence<C>>({
    select: () => db.from('sports_events').select(columns, { count: 'exact' }) as unknown as WindowQuery,
    familyId,
    singlesFilter: timedWindowFilter(bounds),
    latest: bounds.timedTo,
    earliest: bounds.timedFrom,
    scope: opts.memberId ? { column: 'member_id', value: opts.memberId } : undefined,
    refine: opts.refine,
    singlesLimit: opts.singlesLimit,
  });
  if (read.error) return { data: null, count: null, error: read.error };
  const occurrences = expandEventsInZone(read.series, new Date(bounds.timedFrom), new Date(bounds.timedTo), timezone);
  return mergeOccurrences(read.singles, occurrences, opts.limit);
}
