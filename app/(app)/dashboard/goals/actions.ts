// The write path for family goals.
//
// `lib/services/goals` opens by naming two invariants the DATABASE does not
// keep — `progress` is 0..100 with no CHECK, and `is_complete = progress >= 100`
// is not derived — and says it enforces them "because a service that lets one
// caller break an invariant the UI depends on is not a boundary". It could not:
// only `createGoal` existed, so every EDIT and every progress change went
// straight from `goals-module` to PostgREST, with the clamp and the completion
// rule living in that component and nowhere else.
//
// Three readers filter on `is_complete` — the module's active/completed split,
// `lib/operating-index/server.ts`, and the digital-twin page — so a caller that
// sent `progress: 100, is_complete: false` desynchronised all three.
'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { createGoal, deleteGoal, setGoalProgress, updateGoal, type UpdateGoalInput } from '@/lib/services/goals';
import { scopeFromUserContext } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';

const PATH = '/dashboard/goals';

export type GoalActionResult = { ok: true; id: string } | { ok: false; error: string };

/** Session + scope, resolved OUTSIDE the try: `requireUserContext` redirects by throwing. */
async function goalScope() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  return scopeFromUserContext(ctx, supabase);
}

export async function saveGoalAction(
  goalId: string | null,
  input: UpdateGoalInput & { title: string },
): Promise<GoalActionResult> {
  const scope = await goalScope();

  try {
    const result = goalId
      ? await updateGoal(scope, goalId, input)
      : await createGoal(scope, {
        title: input.title,
        description: input.description ?? null,
        targetDate: input.targetDate ?? null,
      });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[goal-action] save failed', err);
    return { ok: false, error: describeActionError(err, 'Could not save that goal.') };
  }
}

/**
 * `progress` is an ABSOLUTE the family chose, so last writer wins — two people
 * each setting a value both got what they asked for. That is the difference
 * from a savings contribution, where the browser computing the total lost money.
 * `is_complete` is derived by the service, not sent from here.
 */
export async function setGoalProgressAction(goalId: string, progress: number): Promise<GoalActionResult> {
  if (!goalId) return { ok: false, error: 'That goal could not be found.' };
  const scope = await goalScope();

  try {
    const result = await setGoalProgress(scope, goalId, progress);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[goal-action] progress failed', err);
    return { ok: false, error: describeActionError(err, 'Could not update that goal.') };
  }
}

export async function deleteGoalAction(goalId: string): Promise<GoalActionResult> {
  if (!goalId) return { ok: false, error: 'That goal could not be found.' };
  const scope = await goalScope();

  try {
    const result = await deleteGoal(scope, goalId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[goal-action] delete failed', err);
    return { ok: false, error: describeActionError(err, 'Could not remove that goal.') };
  }
}
