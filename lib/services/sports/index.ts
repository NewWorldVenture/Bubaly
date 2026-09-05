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
import { expandEvents } from '@/lib/calendar/recurrence';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { resolveWindow } from '../school';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type TeamRow = Tables<'teams'>;
export type SportsEventRow = Tables<'sports_events'>;

const MAX_ROWS = 500;
/** A recurring series is read back this far so its occurrences in the window are found. */
const RECURRENCE_LOOKBACK_MS = 366 * 86_400_000;

export async function listTeams(scope: ServiceScope, input: { memberId?: string | null; activeOnly?: boolean } = {}): Promise<ServiceResult<TeamRow[]>> {
  let query = scope.db
    .from('teams')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('team_name', { ascending: true })
    .limit(MAX_ROWS);
  if (input.activeOnly ?? true) query = query.eq('is_active', true);
  if (input.memberId) query = query.eq('member_id', input.memberId);
  const { data, error } = await query;
  if (error) {
    console.error('[service:sports] teams read failed', error);
    return fail(describeDbError(error, 'Could not load the teams.'), { code: SERVICE_CODES.db });
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
  const window = resolveWindow(scope, input);
  if (!window.ok) return window;
  const fromMs = Date.parse(window.data.from);
  const toMs = Date.parse(window.data.to);

  // Two reads: the one-off rows inside the window, and every recurring row
  // that started before the window ends (a weekly practice entered last
  // season still repeats into it).
  let single = scope.db
    .from('sports_events')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('recurrence', 'none')
    .gte('starts_at', window.data.from)
    .lte('starts_at', window.data.to)
    .limit(MAX_ROWS);
  let recurring = scope.db
    .from('sports_events')
    .select('*')
    .eq('family_id', scope.familyId)
    .neq('recurrence', 'none')
    .gte('starts_at', new Date(toMs - RECURRENCE_LOOKBACK_MS).toISOString())
    .lte('starts_at', window.data.to)
    .limit(MAX_ROWS);
  if (input.memberId) {
    single = single.eq('member_id', input.memberId);
    recurring = recurring.eq('member_id', input.memberId);
  }
  if (input.eventType) {
    single = single.eq('event_type', input.eventType);
    recurring = recurring.eq('event_type', input.eventType);
  }

  const [singles, series] = await Promise.all([single, recurring]);
  if (singles.error || series.error) {
    console.error('[service:sports] events read failed', singles.error ?? series.error);
    return fail(describeDbError(singles.error ?? series.error, 'Could not load sports events.'), { code: SERVICE_CODES.db });
  }

  // `expandEvents` treats the window end as exclusive; the reads above are
  // inclusive, so a millisecond is added to keep an event exactly at `to`.
  const expanded = expandEvents(series.data ?? [], new Date(fromMs), new Date(toMs + 1));
  const rows = [...(singles.data ?? []), ...expanded]
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
    .slice(0, Math.min(Math.max(input.limit ?? 200, 1), MAX_ROWS));
  return ok(rows);
}
