// The write path for chores a family drives by hand.
//
// Three of the four writes on the chores board move here. The fourth — approval —
// deliberately does not, and the reason is worth stating where the others live.
//
// APPROVAL IS NOT ROUTED, and it is not an oversight. There are two approval
// paths in this product and they produce different rows:
//
//   `finalizeApproval` (app/(app)/missions/actions.ts), the proof-and-score flow,
//   computes the reward with `computeReward(rewardConfig(chore), score)`, writes
//   BOTH `points_awarded` and `cash_awarded_cents`, calls `applyCompletionRewards`
//   (rolling the assignment back if that throws), and writes an approval event
//   through `logChoreEvent`.
//
//   The chores board's own approve writes `points_awarded: chore.points`, no
//   cash, no completion rewards, and no event.
//
// So the same chore approved from two screens pays a child differently and leaves
// a different trail. Reconciling them is a product decision about what the simple
// board's approval is FOR — whether it should pay cash and log an event like the
// missions flow, or stay a lightweight tick — and it touches money, so it is not
// a call-site change to make quietly. It stays where it is, named here and in
// tests/chore-single-write-path.test.ts, until that is decided.
//
// What IS safe and unambiguous: the progress transitions, the delete, and the
// create — all family-scoped in the service where the client filtered `id` alone.
'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  completeChoreAssignment, createChore, deleteChoreAssignment, setChoreProgress,
} from '@/lib/services/tasks';
import { scopeFromUserContext } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';
import type { Priority, RecurrenceFreq } from '@/lib/database.types';

const PATH = '/dashboard/chores';

export type ChoreActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * A status change reports the status it SETTLED on, not the one asked for.
 *
 * `completeChoreAssignment` reads the chore's `requires_approval` and lands on
 * `done` when no parent is needed. A caller that assumes its own argument came
 * back would tell a child "Submitted for approval!" about a chore that is
 * already finished — a small lie, but exactly the kind the one-write-path work
 * is supposed to remove rather than introduce.
 */
export type ChoreStatusResult =
  | { ok: true; id: string; status: string }
  | { ok: false; error: string };

/**
 * Session + scope, resolved OUTSIDE the try: `requireUserContext` redirects a
 * signed-out caller by throwing, and catching that would answer `{ ok: false }`
 * and show them a toast instead.
 *
 * No idempotency key is threaded here — see `createChoreAction` for why chore
 * creation is not deduplicated yet.
 */
async function choreScope() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  return { ctx, scope: scopeFromUserContext(ctx, supabase) };
}

/**
 * Move a chore between the statuses a member drives.
 *
 * `submitted` is not one of them here: it goes through `completeChoreAssignment`,
 * which reads the chore's `requires_approval` and settles on `done` when no
 * parent is needed. The board used to write `submitted` either way, so a chore
 * set not to need approval still waited for one.
 */
export async function setChoreStatusAction(
  assignmentId: string,
  status: 'todo' | 'in_progress' | 'submitted',
): Promise<ChoreStatusResult> {
  if (!assignmentId) return { ok: false, error: 'That chore could not be found.' };
  const { scope } = await choreScope();

  try {
    const result = status === 'submitted'
      ? await completeChoreAssignment(scope, assignmentId)
      : await setChoreProgress(scope, assignmentId, status);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id, status: result.data.status };
  } catch (err) {
    console.error('[chore-action] status failed', err);
    return { ok: false, error: describeActionError(err, 'Could not update that chore.') };
  }
}

export async function deleteChoreAssignmentAction(assignmentId: string): Promise<ChoreActionResult> {
  if (!assignmentId) return { ok: false, error: 'That chore could not be found.' };
  const { scope } = await choreScope();

  try {
    const result = await deleteChoreAssignment(scope, assignmentId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[chore-action] delete failed', err);
    return { ok: false, error: describeActionError(err, 'Could not remove that chore.') };
  }
}

export type CreateChoreActionInput = {
  title: string;
  description?: string | null;
  points?: number;
  priority?: string;
  recurrence?: string;
  icon?: string | null;
  dueAt?: string | null;
  /** `family_members.id`. The board always assigns on creation. */
  assigneeId?: string | null;
};

const PRIORITIES: Priority[] = ['low', 'medium', 'high'];
const RECURRENCES: RecurrenceFreq[] = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

export async function createChoreAction(input: CreateChoreActionInput): Promise<ChoreActionResult> {
  // NO submission id here, deliberately. `chore_assignments` is one of 0256's six
  // keyed tables, but neither `createChore` nor `assignChore` calls
  // `withIdempotency`, so a key on the scope would be silently ignored — and
  // wiring it into `assignChore` alone would be worse than nothing: a
  // double-tapped Add creates a second CHORE row (chores is not a keyed table),
  // then the assignment probe returns the first assignment, leaving an orphan
  // chore nobody is assigned to. Deduplicating chore creation means keying the
  // whole two-row create, which is a service change and its own piece of work.
  // Until then this create is not deduplicated, and says so rather than shipping
  // a parameter that does nothing.
  const { scope } = await choreScope();

  try {
    const result = await createChore(scope, {
      title: input.title ?? '',
      description: input.description ?? null,
      points: input.points,
      priority: PRIORITIES.find((p) => p === input.priority),
      recurrence: RECURRENCES.find((r) => r === input.recurrence),
      icon: input.icon ?? null,
      dueAt: input.dueAt ?? null,
      assigneeId: input.assigneeId ?? null,
    });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.chore.id };
  } catch (err) {
    console.error('[chore-action] create failed', err);
    return { ok: false, error: describeActionError(err, 'Could not add that chore.') };
  }
}
