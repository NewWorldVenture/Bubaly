// The write path for to-dos a person adds or edits by hand.
//
// The third §7 surface, and the calendar's shape rather than the groceries':
// `createTodo` guards with `withIdempotency` against 0256's partial unique index
// on `todo_items`, so a save attempt carries a submission id the browser mints
// per composition. Two children each needing "Pack the kit" are two
// compositions and get two rows; one parent pressing Add twice after a lost
// response is one composition and gets one.
//
// `updateTodo` and `deleteTodo` did not exist before this tranche — the service
// had `completeTodo` and `assignTodo` only, so the edit modal and the delete
// button had nowhere to go and went straight to PostgREST. Both now filter
// `family_id` as well as `id`, which the client path left to RLS alone.
//
// DEPLOY COUPLING: `createTodo` names `idempotency_key`, which migration 0256
// adds — the same coupling the calendar tranche recorded in
// docs/PENDING_PROD_MIGRATIONS.md. It was already true of Bubaly's to-do writes;
// this extends it to the family's own Add Task.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { completeTodo, createTodo, deleteTodo, updateTodo } from '@/lib/services/tasks';
import { ALREADY_SAVED, makeKey } from '@/lib/services/idempotency';
import { scopeFromUserContext } from '@/lib/services/scope';
import { isSubmissionId } from '@/lib/utils/submission-id';
import { describeActionError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';

const PATH = '/dashboard/todos';

export type TodoActionResult =
  | { ok: true; id: string }
  /**
   * `already_saved`: this submission id already wrote a task, and that task no
   * longer matches the one just sent — see `KeyedCreateOptions` in
   * lib/services/idempotency.ts. That attempt is settled, so the browser should
   * treat the next press as a new composition rather than retry this one
   * (`submissionSettled`).
   */
  | { ok: false; error: string; code?: typeof ALREADY_SAVED };

export type TodoFields = {
  title?: string;
  notes?: string | null;
  /** `YYYY-MM-DD`; the column is a date, not a timestamp. */
  dueDate?: string | null;
  priority?: string;
  /** `family_members.id`; null unassigns. */
  assigneeId?: string | null;
};

export type CreateTodoActionInput = TodoFields & {
  title: string;
  listId?: string | null;
  /** Minted per composition in the browser; see `lib/utils/submission-id.ts`. */
  submissionId?: string;
};

/**
 * The idempotency key for one save attempt, or null for "do not deduplicate".
 *
 * Namespaced by operation so the same submission id could never have a second,
 * different write answered with the first one's row. It is deliberately NOT
 * keyed on the task's content (two identical "Pack the kit" compositions must
 * both land), so a same-operation retry whose content changed — Today pressed,
 * response lost, Tomorrow pressed — reaches the same key; `createTodo`, asked
 * to by `rejectChangedRetry`, compares the stored row and answers
 * `already_saved` instead of a false "Task added". The Add Event and Add Chore
 * modals do the same through their own actions.
 * A missing or malformed id degrades to today's un-deduplicated write rather
 * than failing the save.
 */
function submissionKey(operation: string, familyId: string, submissionId: unknown): string | null {
  return isSubmissionId(submissionId) ? makeKey([operation, familyId, submissionId]) : null;
}

/**
 * Session + scope, resolved OUTSIDE each action's `try`.
 *
 * `requireUserContext` sends a signed-out caller to /login by calling
 * `redirect()`, which works by throwing. Catching that would answer
 * `{ ok: false }` and show a toast to someone who should have been redirected.
 */
async function todoScope(extra?: { idempotencyKey?: string | null }) {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  return { ctx, scope: scopeFromUserContext(ctx, supabase, extra) };
}

export async function createTodoAction(input: CreateTodoActionInput): Promise<TodoActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase, {
    idempotencyKey: submissionKey('tasks.createTodo', ctx.active.familyId, input.submissionId),
  });

  try {
    const result = await createTodo(scope, {
      title: input.title ?? '',
      listId: input.listId ?? null,
      notes: input.notes ?? null,
      dueDate: input.dueDate ?? null,
      priority: input.priority,
      // `undefined` lets the service default to the acting member, so a
      // self-added task is not orphaned; an explicit null unassigns.
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    }, {
      // The key is a person's submission id, not a plan step: a changed press
      // under it is a change of mind, not the same save (see KeyedCreateOptions).
      rejectChangedRetry: true,
    });
    if (!result.ok) {
      return result.code === ALREADY_SAVED
        ? { ok: false, error: result.error, code: ALREADY_SAVED }
        : { ok: false, error: result.error };
    }

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[todo-action] create failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotAddThatTask')) };
  }
}

export async function updateTodoAction(todoId: string, patch: TodoFields): Promise<TodoActionResult> {
  const t = await getTranslations();
  if (!todoId) return { ok: false, error: t('actions.thatTaskCouldNotBe') };
  const { scope } = await todoScope();

  try {
    // Only the keys the caller actually sent, so a modal cannot blank a field it
    // never rendered.
    const result = await updateTodo(scope, todoId, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
    });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[todo-action] update failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUpdateThatTask')) };
  }
}

/**
 * Tick a task off, or un-tick it.
 *
 * Separate from `updateTodoAction` because the service keeps it separate: it
 * stamps `completed_at` alongside `is_done`, and the two must not drift apart —
 * a done task with no completion time is a row every "what got finished this
 * week" read quietly misses.
 */
export async function completeTodoAction(todoId: string, done: boolean): Promise<TodoActionResult> {
  const t = await getTranslations();
  if (!todoId) return { ok: false, error: t('actions.thatTaskCouldNotBe') };
  const { scope } = await todoScope();

  try {
    const result = await completeTodo(scope, todoId, done);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[todo-action] complete failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUpdateThatTask')) };
  }
}

/**
 * Who may remove a to-do.
 *
 * The service scopes by id + family_id and the RLS is `is_family_member` for
 * all, so any active member — a guest ("view limited shared events only") or a
 * caregiver ("view only the areas assigned to them") included — could delete
 * every family task. A manager may remove any; a teen or child only one they
 * created; a guest or caregiver none.
 *
 * Authorship only: `assigned_to_id` is not ownership. updateTodoAction lets any
 * member set it, so accepting it let a teen reassign a parent's task to
 * themselves and then delete it. `todo_items.created_by` references
 * family_members (0015), so it is compared with the caller's member id.
 */
async function canDeleteTodo(
  scope: Awaited<ReturnType<typeof todoScope>>['scope'],
  todoId: string,
): Promise<boolean> {
  if (isManager(scope.role)) return true;
  if (scope.role !== 'teen' && scope.role !== 'child') return false;
  if (!scope.memberId) return false;
  const { data } = await scope.db
    .from('todo_items')
    .select('created_by')
    .eq('id', todoId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (!data) return false;
  return data.created_by === scope.memberId;
}

export async function deleteTodoAction(todoId: string): Promise<TodoActionResult> {
  const t = await getTranslations();
  if (!todoId) return { ok: false, error: t('actions.thatTaskCouldNotBe') };
  const { scope } = await todoScope();

  try {
    if (!(await canDeleteTodo(scope, todoId))) {
      return { ok: false, error: t('actions.onlyAParentGuardianCan16') };
    }
    const result = await deleteTodo(scope, todoId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[todo-action] delete failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotRemoveThatTask')) };
  }
}
