// Sports reads: which teams the kids are on and when they practise or play.
//
// `sports_events` (0002) is the one household table besides `calendar_events`
// that carries a recurrence rule, and weekly practice is exactly the row a
// family enters once and expects to see every week. A plain window read would
// show the first practice and then nothing, so this service reads through the
// shared series-aware read (lib/calendar/occurrences.ts) — occurrences keep
// the source row's id with shifted times, which is what a planner needs to say
// "soccer is Tuesday at 5 again".
//
// Read-only, family-scoped explicitly, and 'education' in the trust taxonomy
// because `TRUST_DOMAINS` has no sports domain and the reads exist to serve
// the same school-week planning.
import 'server-only';
import { readSportsOccurrences } from '@/lib/calendar/occurrences';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { resolveWindow } from '../school';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type TeamRow = Tables<'teams'>;
export type SportsEventRow = Tables<'sports_events'>;

const MAX_ROWS = 500;

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
 *
 * The read is the shared series-aware one (lib/calendar/occurrences.ts), so
 * this service, the free-slot finder, the reminder engine and the briefs all
 * see the same practices. `to` is inclusive, as this window has always been.
 */
export async function listPracticesBetween(scope: ServiceScope, input: PracticesInput = {}): Promise<ServiceResult<SportsEventRow[]>> {
  const window = resolveWindow(scope, input);
  if (!window.ok) return window;
  const eventType = input.eventType;
  const res = await readSportsOccurrences(
    scope.db,
    scope.familyId,
    { timedFrom: window.data.from, timedTo: new Date(Date.parse(window.data.to) + 1).toISOString() },
    scope.tz,
    {
      memberId: input.memberId ?? undefined,
      refine: eventType ? (query) => query.eq('event_type', eventType) : undefined,
      // The one-off read keeps its database-side cap; the answer is cut to the caller's limit after the merge.
      singlesLimit: MAX_ROWS,
      limit: Math.min(Math.max(input.limit ?? 200, 1), MAX_ROWS),
    },
  );
  if (res.error) {
    console.error('[service:sports] events read failed', res.error);
    return fail(describeDbError(res.error, 'Could not load sports events.'), { code: SERVICE_CODES.db });
  }
  return ok(res.data as SportsEventRow[]);
}
