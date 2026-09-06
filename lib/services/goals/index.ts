// Family goals — the things a household is working towards together.
//
// Same reason for existing as `lib/services/notes`: `public.goals` was written
// only by the hand-written chat tool, so a gated "create a goal" approval could
// be granted and then fail to execute, because the replay resolves tool names
// through the registry.
//
// `goals.created_by` references `auth.users` (0002_tables.sql:379), so
// `scope.userId` is correct here.
//
// TWO INVARIANTS THE DATABASE DOES NOT KEEP, AND THIS SERVICE DOES:
//
//   * `progress` is commented `-- 0..100` in the migration and has NO CHECK
//     constraint. The clamp lives only in `components/modules/goals-module.tsx`,
//     so a value written straight from model output could put 5000 in the
//     column and every progress bar in the app would render off the end.
//   * `is_complete` is not derived by the database either; the rule
//     `is_complete = progress >= 100` also lives only in that module. Writing
//     one without the other silently desynchronises the module's active vs
//     completed split, `lib/operating-index/server.ts` and the digital-twin
//     page, all of which filter on `is_complete`.
//
// Both are enforced here rather than left to callers, because a service that
// lets one caller break an invariant the UI depends on is not a boundary.
import 'server-only';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type FamilyGoal = Tables<'goals'>;

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5_000;

/** `target_date` is a bare DATE column, so only a calendar day is meaningful. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A real calendar day, checked by round-tripping through UTC. `Date.parse`
 * alone accepts '2026-02-31' and rolls it to March, which would silently store
 * a target the family never chose — the same trap `lib/services/memory` fell
 * into with expiry dates.
 */
function isRealCalendarDate(value: string): boolean {
  const m = DATE_ONLY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const asUtc = new Date(Date.UTC(y, mo - 1, d));
  return asUtc.getUTCFullYear() === y && asUtc.getUTCMonth() === mo - 1 && asUtc.getUTCDate() === d;
}

export type CreateGoalInput = {
  title: string;
  description?: string | null;
  /** ISO calendar day, YYYY-MM-DD. */
  targetDate?: string | null;
  progress?: number | null;
};

export async function createGoal(scope: ServiceScope, input: CreateGoalInput): Promise<ServiceResult<FamilyGoal>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('A goal needs a title.', { code: SERVICE_CODES.invalidInput });
  if (title.length > MAX_TITLE) {
    return fail(`That goal title is too long — keep it under ${MAX_TITLE} characters.`, { code: SERVICE_CODES.invalidInput });
  }

  const description = input.description?.trim() || null;
  if (description && description.length > MAX_DESCRIPTION) {
    return fail(`That goal description is too long — keep it under ${MAX_DESCRIPTION.toLocaleString()} characters.`, { code: SERVICE_CODES.invalidInput });
  }

  let targetDate: string | null = null;
  if (input.targetDate) {
    const raw = input.targetDate.trim();
    if (!isRealCalendarDate(raw)) {
      return fail('That target date could not be understood — use a real calendar day like 2026-12-01.', { code: SERVICE_CODES.invalidInput });
    }
    targetDate = raw;
  }

  // Refused rather than clamped. A caller that asks for 250% has misunderstood
  // the field, and silently storing 100 answers a question nobody asked — the
  // same choice `createChore` makes about negative points.
  const progressIn = input.progress ?? 0;
  if (!Number.isFinite(progressIn) || progressIn < 0 || progressIn > 100) {
    return fail('Goal progress is a percentage between 0 and 100.', { code: SERVICE_CODES.invalidInput });
  }
  const progress = Math.round(progressIn);

  const { data, error } = await scope.db
    .from('goals')
    .insert({
      family_id: scope.familyId,
      title,
      description,
      target_date: targetDate,
      progress,
      // Kept in step with `progress` here because the database does not do it
      // and three separate readers filter on it.
      is_complete: progress >= 100,
      created_by: scope.userId,
    })
    .select('*')
    .single();

  if (error || !data) {
    console.error('[service:goals] create failed', error);
    return fail(describeDbError(error, 'Could not create that goal.'), { code: SERVICE_CODES.db });
  }

  await recordActivitySafely(scope, {
    agent: 'goals',
    title: `Created the goal "${title}"`,
    detail: targetDate,
    href: '/dashboard/goals',
  });
  return ok(data);
}
