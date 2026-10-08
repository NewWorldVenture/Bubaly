// Sports reads: which teams the kids are on and when they practise or play.
//
// `sports_events` (0002) is the one household table besides `calendar_events`
// that carries a recurrence rule, and weekly practice is exactly the row a
// family enters once and expects to see every week. A plain window read would
// show the first practice and then nothing, so this service expands the rule
// with the same `expandEvents` the calendar views use — occurrences keep the
// source row's id with shifted times, which is what a planner needs to say
// "soccer is Tuesday at 5 again".
//
// Read-only, family-scoped explicitly, and 'education' in the trust taxonomy
// because `TRUST_DOMAINS` has no sports domain and the reads exist to serve
// the same school-week planning.
import 'server-only';
import { expandEventsInZone } from '@/lib/calendar/recurrence';
import { readCountedRows } from '@/lib/calendar/occurrences';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { resolveWindow } from '../school';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type TeamRow = Tables<'teams'>;
export type SportsEventRow = Tables<'sports_events'>;

const MAX_ROWS = 500;
const MAX_SERIES = 2000;

/** requireComplete pages through server caps and refuses more than 2,000 teams. */
export async function listTeams(scope: ServiceScope, input: { memberId?: string | null; activeOnly?: boolean; requireComplete?: boolean } = {}): Promise<ServiceResult<TeamRow[]>> {
  const query = (counted = false) => {
    const table = scope.db.from('teams');
    let read = (counted ? table.select('*', { count: 'exact' }) : table.select('*'))
      .eq('family_id', scope.familyId).order('team_name', { ascending: true });
    if (counted) read = read.order('id');
    if (input.activeOnly ?? true) read = read.eq('is_active', true);
    if (input.memberId) read = read.eq('member_id', input.memberId);
    return read;
  };
  const { data, error } = input.requireComplete
    ? await readCountedRows<TeamRow>(
      () => query(true).limit(MAX_ROWS), (from, to) => query(true).range(from, to),
      2000, 'sports teams',
    )
    : await query().limit(MAX_ROWS);
  if (error) {
    console.error('[service:sports] teams read failed', error);
    return fail(describeDbError(error, 'Could not load the teams.'), { code: SERVICE_CODES.db });
  }
  if (data != null && !Array.isArray(data)) {
    return fail('Could not load the teams.', { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

export type PracticesInput = {
  from?: string | null;
  to?: string | null;
  memberId?: string | null;
  /** 'practice' | 'game' | 'tournament' … as stored; omit for every kind. */
  eventType?: string | null;
  limit?: number;
};

/**
 * Practices, games and tournaments in a window, recurring series expanded,
 * soonest first. Each occurrence keeps its source row's id.
 */
export async function listPracticesBetween(scope: ServiceScope, input: PracticesInput = {}): Promise<ServiceResult<SportsEventRow[]>> {
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
    return fail('The sports event limit must be a positive whole number.', { code: SERVICE_CODES.invalidInput });
  }
  const limit = Math.min(input.limit ?? 200, MAX_ROWS);
  const window = resolveWindow(scope, input);
  if (!window.ok) return window;
  const fromMs = Date.parse(window.data.from);
  const toMs = Date.parse(window.data.to);

  // Two reads: the one-off rows inside the window, and every recurring row
  // that started before the window ends (a weekly practice entered last
  // season still repeats into it).
  const query = (series: boolean) => {
    let read = scope.db.from('sports_events').select('*', { count: 'exact' })
      .eq('family_id', scope.familyId).lte('starts_at', window.data.to);
    read = series
      ? read.neq('recurrence', 'none').or(`recurrence_until.is.null,recurrence_until.gt.${window.data.from}`)
      : read.eq('recurrence', 'none').gte('starts_at', window.data.from);
    if (input.memberId) read = read.eq('member_id', input.memberId);
    if (input.eventType) read = read.eq('event_type', input.eventType);
    return read.order('starts_at').order('id');
  };

  // Only the nearest `limit` singles can enter the merged result. Series must
  // be read whole: an old master's next occurrence can precede a newer one's.
  const [singles, series] = await Promise.all([
    readCountedRows<SportsEventRow>(() => query(false).limit(limit), (from, to) => query(false).range(from, to), MAX_ROWS, 'sports one-off events', limit),
    readCountedRows<SportsEventRow>(() => query(true).limit(MAX_ROWS), (from, to) => query(true).range(from, to), MAX_SERIES, 'sports recurring events'),
  ]);
  if (singles.error || series.error) {
    console.error('[service:sports] events read failed', singles.error ?? series.error);
    return fail(describeDbError(singles.error ?? series.error, 'Could not load sports events.'), { code: SERVICE_CODES.db });
  }

  // `expandEvents` treats the window end as exclusive; the reads above are
  // inclusive, so a millisecond is added to keep an event exactly at `to`.
  let expanded: SportsEventRow[];
  try {
    expanded = expandEventsInZone(series.data ?? [], new Date(fromMs), new Date(toMs + 1), scope.tz, false, { requireComplete: true });
  } catch (cause) {
    return fail(describeDbError(cause, 'Could not read the whole sports schedule.'), { code: SERVICE_CODES.db });
  }
  const rows = [...(singles.data ?? []), ...expanded]
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.id.localeCompare(b.id))
    .slice(0, limit);
  return ok(rows);
}
