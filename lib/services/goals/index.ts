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
    action: 'create',
    title: `Created the goal "${title}"`,
    detail: targetDate,
    href: '/dashboard/goals',
  });
  return ok(data);
}

/**
 * The invariants above are only real on the paths that go through this service.
 * Until now only `createGoal` existed, so every EDIT and every progress change
 * went straight from `goals-module` to PostgREST — the clamp and the
 * `is_complete = progress >= 100` rule lived in that component and nowhere else.
 * A service that documents an invariant it cannot enforce on the path that
 * actually changes the value is not a boundary; these close that.
 */
export type UpdateGoalInput = {
  title?: string;
  description?: string | null;
  targetDate?: string | null;
};

export async function updateGoal(
  scope: ServiceScope,
  goalId: string,
  input: UpdateGoalInput,
): Promise<ServiceResult<FamilyGoal>> {
  const patch: Partial<{ title: string; description: string | null; target_date: string | null }> = {};

  if (input.title !== undefined) {
    const title = input.title?.trim() ?? '';
    if (!title) return fail('A goal needs a title.', { code: SERVICE_CODES.invalidInput });
    if (title.length > MAX_TITLE) {
      return fail(`That goal title is too long — keep it under ${MAX_TITLE} characters.`, { code: SERVICE_CODES.invalidInput });
    }
    patch.title = title;
  }

  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    if (description && description.length > MAX_DESCRIPTION) {
      return fail(`That goal description is too long — keep it under ${MAX_DESCRIPTION.toLocaleString()} characters.`, { code: SERVICE_CODES.invalidInput });
    }
    patch.description = description;
  }

  if (input.targetDate !== undefined) {
    if (input.targetDate === null || input.targetDate.trim() === '') {
      patch.target_date = null;
    } else {
      const raw = input.targetDate.trim();
      if (!isRealCalendarDate(raw)) {
        return fail('That target date could not be understood — use a real calendar day like 2026-12-01.', { code: SERVICE_CODES.invalidInput });
      }
      patch.target_date = raw;
    }
  }

  if (Object.keys(patch).length === 0) {
    return fail('There is nothing to change on that goal.', { code: SERVICE_CODES.invalidInput });
  }

  const { data, error } = await scope.db
    .from('goals')
    .update(patch)
    .eq('id', goalId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:goals] update failed', error);
    return fail(describeDbError(error, 'Could not update that goal.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That goal could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'goals',
    action: 'update',
    title: `Updated the goal "${data.title}"`,
    href: '/dashboard/goals',
    resourceId: data.id,
  });
  return ok(data);
}

/**
 * Set a goal's progress.
 *
 * An ABSOLUTE, not a delta, and deliberately so: the family drags a slider to
 * "60%", they are not adding six points to whatever is there. Last writer wins
 * is the honest semantic for that — two people each setting a value both got
 * what they asked for, and the later one is the answer. This is the difference
 * from `contributeToSavingsGoal`, where the browser computing the total lost
 * contributions and a compare-and-set was required.
 *
 * `is_complete` is DERIVED here rather than accepted from the caller. The module
 * used to send both, so a caller that sent `progress: 100, is_complete: false`
 * would have desynchronised the module's active/completed split,
 * `lib/operating-index/server.ts` and the digital-twin page, all of which filter
 * on that column.
 */
export async function setGoalProgress(
  scope: ServiceScope,
  goalId: string,
  progress: number,
): Promise<ServiceResult<FamilyGoal>> {
  // Refused rather than clamped, matching `createGoal`: a caller asking for
  // 250% has misunderstood the field.
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    return fail('Goal progress is a percentage between 0 and 100.', { code: SERVICE_CODES.invalidInput });
  }
  const next = Math.round(progress);

  const { data, error } = await scope.db
    .from('goals')
    .update({ progress: next, is_complete: next >= 100 })
    .eq('id', goalId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:goals] progress update failed', error);
    return fail(describeDbError(error, 'Could not update that goal.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That goal could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'goals',
    action: 'update',
    title: next >= 100
      ? `Finished the goal "${data.title}"`
      : `Moved "${data.title}" to ${next}%`,
    href: '/dashboard/goals',
    resourceId: data.id,
  });
  return ok(data);
}

/** Remove a goal. Family-scoped, where the module deleted on `id` alone. */
export async function deleteGoal(scope: ServiceScope, goalId: string): Promise<ServiceResult<{ id: string }>> {
  const { data, error } = await scope.db
    .from('goals')
    .delete()
    .eq('id', goalId)
    .eq('family_id', scope.familyId)
    .select('id, title')
    .maybeSingle();
  if (error) {
    console.error('[service:goals] delete failed', error);
    return fail(describeDbError(error, 'Could not remove that goal.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That goal could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'goals',
    action: 'delete',
    title: `Removed the goal "${data.title}"`,
    href: '/dashboard/goals',
    resourceId: data.id,
  });
  return ok({ id: data.id });
}
