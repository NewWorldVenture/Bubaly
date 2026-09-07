// To-dos and chores — the two task shapes the household actually has.
//
// THE FOREIGN KEY THIS FILE EXISTS TO FIX: `todo_lists.created_by` and
// `todo_items.created_by` reference `public.family_members(id)`, not
// `auth.users` (migration 0015). `lib/assistant/tools.ts` passes the auth user
// id into both, so the assistant's very first "add a to-do" hits a foreign key
// violation that the UI path never sees. Everything written here passes
// `scope.memberId` for those columns. The chore tables are the opposite way
// round — `chores.created_by` references `auth.users` (0002) — which is
// exactly why the rule is "read the migration that created the table", not
// "use the member id everywhere".
//
// `chore_assignments.member_id` is NOT NULL, so a chore cannot be assigned to
// "the family"; a chore with nobody to do it is a chore nobody does.
import 'server-only';
import type { Priority, RecurrenceFreq, TaskStatus, Tables, Updatable } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { keyedProbe, withIdempotency, type IdempotencyProbe } from '../idempotency';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type TodoList = Tables<'todo_lists'>;
export type TodoItem = Tables<'todo_items'>;
export type Chore = Tables<'chores'>;
export type ChoreAssignment = Tables<'chore_assignments'>;

/** The one name the default list is created under, so UI and AI converge on a single list. */
export const DEFAULT_TODO_LIST_NAME = 'To-Do';

const TODO_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Get-or-create the family's default to-do list.
 *
 * The oldest un-archived list wins so that a family who renamed theirs keeps
 * using it instead of accumulating a second "To-Do" every time the assistant
 * runs. Creation is only attempted when no list exists at all.
 */
export async function ensureTodoList(scope: ServiceScope, name?: string): Promise<ServiceResult<{ id: string; created: boolean }>> {
  const wanted = name?.trim() || DEFAULT_TODO_LIST_NAME;

  let lookup = scope.db
    .from('todo_lists')
    .select('id')
    .eq('family_id', scope.familyId)
    .is('archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1);
  if (name?.trim()) lookup = lookup.eq('name', wanted);

  const { data: existing, error: lookupError } = await lookup.maybeSingle();
  if (lookupError) {
    console.error('[service:tasks] to-do list lookup failed', lookupError);
    return fail(describeDbError(lookupError, 'Could not open your to-do lists.'), { code: SERVICE_CODES.db });
  }
  if (existing?.id) return ok({ id: existing.id, created: false });

  const { data, error } = await scope.db
    .from('todo_lists')
    // created_by references family_members(id) — see the header note.
    .insert({ family_id: scope.familyId, name: wanted, created_by: scope.memberId })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[service:tasks] to-do list create failed', error);
    return fail(describeDbError(error, 'Could not create a to-do list.'), { code: SERVICE_CODES.db });
  }
  return ok({ id: data.id, created: true });
}

export type CreateTodoInput = {
  title: string;
  listId?: string | null;
  notes?: string | null;
  /** `family_members.id`. Defaults to the acting member so a self-added task is not orphaned. */
  assigneeId?: string | null;
  /** `YYYY-MM-DD` — `todo_items.due_date` is a date column, not a timestamp. */
  dueDate?: string | null;
  priority?: string;
  tags?: string[];
};

export async function createTodo(scope: ServiceScope, input: CreateTodoInput): Promise<ServiceResult<TodoItem>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('A task needs a title.', { code: SERVICE_CODES.invalidInput });
  if (input.dueDate && !DAY_KEY.test(input.dueDate)) {
    return fail('A due date must look like 2026-09-05.', { code: SERVICE_CODES.invalidInput });
  }

  const list = input.listId ? { ok: true as const, data: { id: input.listId, created: false } } : await ensureTodoList(scope);
  if (!list.ok) return list;

  const priority = input.priority && TODO_PRIORITIES.includes(input.priority) ? input.priority : 'medium';
  const assigneeId = input.assigneeId !== undefined ? input.assigneeId : scope.memberId;

  return withIdempotency<TodoItem>(
    scope,
    {
      operation: 'tasks.createTodo',
      input: { title, listId: list.data.id, dueDate: input.dueDate ?? null },
      // 0256: keyed on the call, so re-running a plan step returns its own
      // to-do while a family that really wants two "Pack the kit" rows gets two.
      find: keyedProbe(scope, 'todo_items', 'task'),
    },
    async (key) => {
      const { data, error } = await scope.db
        .from('todo_items')
        .insert({
          family_id: scope.familyId,
          list_id: list.data.id,
          title,
          notes: input.notes?.trim() || null,
          // Both columns reference family_members(id) — see the header note.
          created_by: scope.memberId,
          assigned_to_id: assigneeId ?? null,
          due_date: input.dueDate ?? null,
          priority,
          tags: input.tags ?? [],
          idempotency_key: key,
        })
        .select('*')
        .single();
      if (error || !data) {
        console.error('[service:tasks] to-do create failed', error);
        return fail(describeDbError(error, 'Could not add that task.'), { code: SERVICE_CODES.db });
      }

      await recordActivitySafely(scope, {
        agent: 'tasks',
        action: 'create',
        title: `Added the task "${title}"`,
        href: '/dashboard/todos',
        memberId: assigneeId ?? null,
      });
      return ok(data);
    },
  );
}

export async function completeTodo(scope: ServiceScope, todoId: string, done = true): Promise<ServiceResult<TodoItem>> {
  const { data, error } = await scope.db
    .from('todo_items')
    .update({ is_done: done, completed_at: done ? new Date().toISOString() : null })
    .eq('id', todoId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:tasks] to-do complete failed', error);
    return fail(describeDbError(error, 'Could not update that task.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That task could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'tasks',
    action: 'update',
    title: done ? `Ticked off "${data.title}"` : `Put "${data.title}" back on the list`,
    href: '/dashboard/todos',
    memberId: data.assigned_to_id,
    resourceId: data.id,
  });
  return ok(data);
}

/** `memberId` is a `family_members.id`; null unassigns. */
export async function assignTodo(scope: ServiceScope, todoId: string, memberId: string | null): Promise<ServiceResult<TodoItem>> {
  const { data, error } = await scope.db
    .from('todo_items')
    .update({ assigned_to_id: memberId })
    .eq('id', todoId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:tasks] to-do assign failed', error);
    return fail(describeDbError(error, 'Could not reassign that task.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That task could not be found.', { code: SERVICE_CODES.notFound });
  return ok(data);
}

export type UpdateTodoPatch = {
  title?: string;
  notes?: string | null;
  /** `YYYY-MM-DD` — `todo_items.due_date` is a date column, not a timestamp. */
  dueDate?: string | null;
  priority?: string;
  /** `family_members.id`; null unassigns. */
  assigneeId?: string | null;
  tags?: string[];
};

/**
 * Edit a to-do.
 *
 * `list_id` is deliberately absent: it is fixed at creation and the generated
 * Update type excludes it, so a caller cannot move a task between lists by
 * accident here.
 *
 * Only the keys actually present are written, so a modal showing four fields
 * cannot blank the two it never rendered — the same contract `updateEvent`
 * keeps, and the reason a spread of the form's state is not good enough.
 */
export async function updateTodo(scope: ServiceScope, todoId: string, patch: UpdateTodoPatch): Promise<ServiceResult<TodoItem>> {
  const update: Updatable<'todo_items'> = {};

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) return fail('A task needs a title.', { code: SERVICE_CODES.invalidInput });
    update.title = title;
  }
  if (patch.dueDate !== undefined) {
    if (patch.dueDate && !DAY_KEY.test(patch.dueDate)) {
      return fail('A due date must look like 2026-09-05.', { code: SERVICE_CODES.invalidInput });
    }
    update.due_date = patch.dueDate || null;
  }
  if (patch.notes !== undefined) update.notes = patch.notes?.trim() || null;
  if (patch.assigneeId !== undefined) update.assigned_to_id = patch.assigneeId;
  if (patch.tags !== undefined) update.tags = patch.tags;
  // An unrecognised priority is dropped rather than sent on: the column is
  // constrained, and a rejected write would lose the rest of the edit with it.
  if (patch.priority !== undefined && TODO_PRIORITIES.includes(patch.priority)) update.priority = patch.priority;

  if (Object.keys(update).length === 0) {
    return fail('Nothing to change on that task.', { code: SERVICE_CODES.invalidInput });
  }

  const { data, error } = await scope.db
    .from('todo_items')
    .update(update)
    .eq('id', todoId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:tasks] to-do update failed', error);
    return fail(describeDbError(error, 'Could not update that task.'), { code: SERVICE_CODES.db });
  }
  // No row means the id belongs to another family (or is gone). "Not found"
  // rather than "denied" avoids confirming that the id exists.
  if (!data) return fail('That task could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'tasks',
    action: 'update',
    title: `Updated the task "${data.title}"`,
    href: '/dashboard/todos',
    memberId: data.assigned_to_id,
  });
  return ok(data);
}

export async function deleteTodo(scope: ServiceScope, todoId: string): Promise<ServiceResult<{ id: string; title: string }>> {
  const { data, error } = await scope.db
    .from('todo_items')
    .delete()
    .eq('id', todoId)
    .eq('family_id', scope.familyId)
    .select('id, title')
    .maybeSingle();
  if (error) {
    console.error('[service:tasks] to-do delete failed', error);
    return fail(describeDbError(error, 'Could not remove that task.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That task could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, { action: 'delete', agent: 'tasks', title: `Removed the task "${data.title}"`, href: '/dashboard/todos' });
  return ok({ id: data.id, title: data.title });
}

export type SearchTodosInput = {
  query?: string | null;
  done?: boolean;
  assigneeId?: string | null;
  listId?: string | null;
  dueBefore?: string | null;
  limit?: number;
};

export async function searchTodos(scope: ServiceScope, input: SearchTodosInput = {}): Promise<ServiceResult<TodoItem[]>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  let query = scope.db
    .from('todo_items')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(limit);

  if (input.done !== undefined) query = query.eq('is_done', input.done);
  if (input.assigneeId) query = query.eq('assigned_to_id', input.assigneeId);
  if (input.listId) query = query.eq('list_id', input.listId);
  if (input.dueBefore) query = query.lte('due_date', input.dueBefore);
  if (input.query?.trim()) {
    const term = input.query.trim().replace(/[%_]/g, (m) => `\\${m}`);
    query = query.ilike('title', `%${term}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[service:tasks] to-do search failed', error);
    return fail(describeDbError(error, 'Could not load your tasks.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

export type CreateChoreInput = {
  title: string;
  description?: string | null;
  points?: number;
  priority?: Priority;
  recurrence?: RecurrenceFreq;
  dueAt?: string | null;
  requiresApproval?: boolean;
  /** The emoji the chores board shows. Nullable in 0043; omitted meant losing it. */
  icon?: string | null;
  /** When set, the chore is created and immediately assigned in one call. */
  assigneeId?: string | null;
};

/**
 * The chore's name, for a trail line about one of its assignments.
 *
 * `chore_assignments` carries no title, so the two functions that change an
 * assignment without touching `chores` need this one extra read. It is a
 * primary-key lookup and it runs AFTER the write, so it cannot delay or fail the
 * change it describes — a trail entry that says "a chore" is worse than one that
 * names it, and both are better than losing the write.
 */
async function choreTitle(scope: ServiceScope, choreId: string | null): Promise<string> {
  if (!choreId) return 'a chore';
  const { data, error } = await scope.db
    .from('chores')
    .select('title')
    .eq('id', choreId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) console.error('[service:tasks] chore title lookup failed', error);
  return data?.title ?? 'a chore';
}

export type ChoreCreation = { chore: Chore; assignment: ChoreAssignment | null };

/**
 * "Has this exact create already run?" — answered through the ASSIGNMENT.
 *
 * `chores` is not one of 0256's keyed tables, so the chore row cannot answer
 * for itself. `chore_assignments` is, and a keyed create always writes one, so
 * finding the assignment identifies the chore behind it. This is the reason the
 * whole two-row create is wrapped rather than just the assignment: keying the
 * assignment alone would let a second chore row be written and then hand back
 * the FIRST assignment, leaving a chore nobody is assigned to.
 *
 * A chore created with no assignee has no keyed row to find, so it cannot be
 * deduplicated and this returns null every time. The board always assigns (it
 * refuses to submit without a member), so that case is the assistant's
 * `tasks.createChore` with no assignee named — recorded rather than papered
 * over, because deduplicating it needs `chores` to carry a key of its own.
 */
function findChoreCreation(scope: ServiceScope, assigneeId: string | null | undefined): IdempotencyProbe<ChoreCreation> {
  const probeAssignment = keyedProbe(scope, 'chore_assignments', 'chore');
  return async (key: string) => {
    if (!assigneeId) return ok(null);

    const found = await probeAssignment(key);
    if (!found.ok) return found;
    if (!found.data) return ok(null);

    const { data: chore, error } = await scope.db
      .from('chores')
      .select('*')
      .eq('id', found.data.chore_id)
      .eq('family_id', scope.familyId)
      .maybeSingle();
    if (error) {
      console.error('[service:tasks] chore lookup for duplicate probe failed', error);
      return fail(describeDbError(error, 'Could not check for a duplicate chore.'), { code: SERVICE_CODES.db });
    }
    // The assignment exists but its chore does not: not a duplicate we can hand
    // back, so let the create run rather than returning half an answer.
    if (!chore) return ok(null);
    return ok({ chore, assignment: found.data });
  };
}

/**
 * Create a chore, optionally assigning it in the same call.
 *
 * If the assignment insert fails the chore is deleted again: a chore nobody is
 * assigned to is invisible on every board that lists work by person, so
 * leaving the orphan behind would look to the family like nothing happened
 * while quietly accumulating rows.
 *
 * That rollback is also what makes the create safe to deduplicate as a UNIT.
 * Two simultaneous taps both find nothing, both insert a chore, and 0256's
 * partial unique index refuses the second assignment — which fails
 * `assignChore`, which rolls that chore back, and `withIdempotency` then
 * re-probes and hands back the row the winner wrote. The loser leaves nothing
 * behind, which is exactly what keying the assignment ALONE could not achieve.
 *
 * DEPLOY COUPLING: the probe half works today; the race half needs 0256's index,
 * which is still pending in production (docs/PENDING_PROD_MIGRATIONS.md).
 */
export async function createChore(
  scope: ServiceScope,
  input: CreateChoreInput,
): Promise<ServiceResult<ChoreCreation>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('A chore needs a title.', { code: SERVICE_CODES.invalidInput });
  // Points are a reward a child earns. A negative one would take points away
  // for doing a chore, and nothing in the product offers that — the chat tool
  // this service replaced clamped with `Math.max(0, …)`, and the clamp was lost
  // on the way to the registry. Refused rather than clamped: silently turning
  // -5 into 0 answers a request nobody made.
  if (input.points != null && (!Number.isFinite(input.points) || input.points < 0)) {
    return fail('A chore cannot be worth negative points.', { code: SERVICE_CODES.invalidInput });
  }

  return withIdempotency(
    scope,
    {
      operation: 'tasks.createChore',
      // Only reached on the ASSISTANT's path. A browser Add supplies
      // `scope.idempotencyKey` directly and `scopeKey` returns it verbatim, so
      // these are unused there; the executor leaves `idempotencyKey` null while
      // setting run/step/request, and then the key is composed from these.
      //
      // Assignee and due date belong in it because two children given the same
      // chore on the same day are two chores, not one, and must not answer for
      // each other.
      input: { title, assigneeId: input.assigneeId ?? null, dueAt: input.dueAt ?? null },
      find: findChoreCreation(scope, input.assigneeId),
    },
    async (key) => {
      const { data: chore, error } = await scope.db
        .from('chores')
        .insert({
          family_id: scope.familyId,
          title,
          description: input.description?.trim() || null,
          points: input.points ?? 10,
          priority: input.priority ?? 'medium',
          recurrence: input.recurrence ?? 'none',
          due_at: input.dueAt ?? null,
          requires_approval: input.requiresApproval ?? true,
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          // chores.created_by references auth.users (0002), unlike the todo tables.
          created_by: scope.userId,
        })
        .select('*')
        .single();
      if (error || !chore) {
        console.error('[service:tasks] chore create failed', error);
        return fail(describeDbError(error, 'Could not add that chore.'), { code: SERVICE_CODES.db });
      }

      let assignment: ChoreAssignment | null = null;
      if (input.assigneeId) {
        const assigned = await assignChore(scope, {
          choreId: chore.id,
          memberId: input.assigneeId,
          dueAt: input.dueAt ?? null,
          idempotencyKey: key,
        });
        if (!assigned.ok) {
          // Covers the lost race as well as a genuine failure: either way this
          // chore has no assignment, and `withIdempotency` re-probes next.
          const { error: rollbackError } = await scope.db.from('chores').delete().eq('id', chore.id).eq('family_id', scope.familyId);
          if (rollbackError) console.error('[service:tasks] chore rollback failed', rollbackError);
          return assigned;
        }
        assignment = assigned.data;
      }

      await recordActivitySafely(scope, {
        agent: 'chores',
        action: 'create',
        title: `Added the chore "${title}"`,
        href: '/dashboard/chores',
        memberId: input.assigneeId ?? null,
        resourceId: chore.id,
      });
      return ok({ chore, assignment });
    },
  );
}

/**
 * `memberId` is a `family_members.id`; `chore_assignments.member_id` is NOT NULL.
 *
 * `idempotencyKey` is supplied by `createChore`, which deduplicates the chore and
 * its assignment as one unit. This function does not probe on it: writing the key
 * is what lets 0256's partial unique index refuse a second identical create, and
 * the caller that owns the pair is the one that can recover from losing.
 */
export async function assignChore(
  scope: ServiceScope,
  input: { choreId: string; memberId: string; dueAt?: string | null; idempotencyKey?: string | null },
): Promise<ServiceResult<ChoreAssignment>> {
  if (!input.memberId) return fail('A chore has to be assigned to someone.', { code: SERVICE_CODES.invalidInput });

  // Confirm the chore belongs to this family before writing an assignment that
  // would otherwise carry a foreign family's chore_id under our family_id.
  const { data: chore, error: choreError } = await scope.db
    .from('chores')
    .select('id, due_at')
    .eq('id', input.choreId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (choreError) {
    console.error('[service:tasks] chore lookup failed', choreError);
    return fail(describeDbError(choreError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }
  if (!chore) return fail('That chore could not be found.', { code: SERVICE_CODES.notFound });

  const { data, error } = await scope.db
    .from('chore_assignments')
    .insert({
      family_id: scope.familyId,
      chore_id: chore.id,
      member_id: input.memberId,
      status: 'todo',
      due_at: input.dueAt ?? chore.due_at ?? null,
      ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:tasks] chore assign failed', error);
    return fail(describeDbError(error, 'Could not assign that chore.'), { code: SERVICE_CODES.db });
  }
  return ok(data);
}

/**
 * Mark an assignment done.
 *
 * A chore whose `requires_approval` is true goes to 'submitted', not 'done':
 * the parent approving it is what awards the points, and skipping that step
 * would let a child bank rewards unilaterally. Points and rewards themselves
 * stay in `lib/chores/server.ts`.
 */
export async function completeChoreAssignment(scope: ServiceScope, assignmentId: string): Promise<ServiceResult<ChoreAssignment>> {
  const { data: assignment, error: readError } = await scope.db
    .from('chore_assignments')
    .select('id, chore_id')
    .eq('id', assignmentId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (readError) {
    console.error('[service:tasks] assignment lookup failed', readError);
    return fail(describeDbError(readError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }
  if (!assignment) return fail('That chore could not be found.', { code: SERVICE_CODES.notFound });

  const { data: chore, error: choreError } = await scope.db
    .from('chores')
    .select('requires_approval, title')
    .eq('id', assignment.chore_id)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (choreError) {
    console.error('[service:tasks] chore approval lookup failed', choreError);
    return fail(describeDbError(choreError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }

  const status: TaskStatus = chore?.requires_approval === false ? 'done' : 'submitted';
  const { data, error } = await scope.db
    .from('chore_assignments')
    .update({ status, submitted_at: new Date().toISOString() })
    .eq('id', assignmentId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:tasks] assignment complete failed', error);
    return fail(describeDbError(error, 'Could not update that chore.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That chore could not be found.', { code: SERVICE_CODES.notFound });

  // The SETTLED status, not the requested one: a chore that needs no approval
  // is done, and the trail must not say it is waiting for a parent.
  await recordActivitySafely(scope, {
    agent: 'chores',
    action: 'update',
    title: status === 'done'
      ? `Finished "${chore?.title ?? 'a chore'}"`
      : `Submitted "${chore?.title ?? 'a chore'}" for approval`,
    href: '/dashboard/chores',
    memberId: data.member_id,
    resourceId: data.id,
  });
  return ok(data);
}

/**
 * The statuses a MEMBER drives directly: picking a chore up, and putting it back.
 *
 * Deliberately excludes the other three. `submitted` belongs to
 * `completeChoreAssignment`, which reads the chore's `requires_approval` and
 * settles on `done` or `submitted` accordingly — a distinction the module's own
 * status setter did not make, so a chore configured to need no approval still
 * sat waiting for a parent who had nothing to do. And `approved`/`rejected` are
 * manager decisions: migration 0223 puts a trigger on exactly those two, so a
 * child cannot forge the completion of their own chore. This function must never
 * grow them — the vocabulary here is the same one 0223 calls member-allowed.
 */
export async function setChoreProgress(
  scope: ServiceScope,
  assignmentId: string,
  status: 'todo' | 'in_progress',
): Promise<ServiceResult<ChoreAssignment>> {
  if (status !== 'todo' && status !== 'in_progress') {
    return fail('That is not a status a member can set.', { code: SERVICE_CODES.invalidInput });
  }

  const update: Updatable<'chore_assignments'> = { status };
  // Putting a chore back to "to do" clears the trail of it having been finished,
  // so the board does not show it as awaiting a decision that is no longer due.
  if (status === 'todo') {
    update.submitted_at = null;
    update.approved_at = null;
  }

  const { data, error } = await scope.db
    .from('chore_assignments')
    .update(update)
    .eq('id', assignmentId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:tasks] chore progress failed', error);
    return fail(describeDbError(error, 'Could not update that chore.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That chore could not be found.', { code: SERVICE_CODES.notFound });

  const title = await choreTitle(scope, data.chore_id);
  await recordActivitySafely(scope, {
    agent: 'chores',
    action: 'update',
    title: status === 'in_progress' ? `Started "${title}"` : `Put "${title}" back to do`,
    href: '/dashboard/chores',
    memberId: data.member_id,
    resourceId: data.id,
  });
  return ok(data);
}

/** Remove an assignment. The chore itself survives — it may be assigned to others. */
export async function deleteChoreAssignment(
  scope: ServiceScope,
  assignmentId: string,
): Promise<ServiceResult<{ id: string }>> {
  // `chore_id` comes back with the deleted row, so naming it on the trail costs
  // no extra round trip here — the row is gone by the time we could ask again.
  const { data, error } = await scope.db
    .from('chore_assignments')
    .delete()
    .eq('id', assignmentId)
    .eq('family_id', scope.familyId)
    .select('id, chore_id, member_id')
    .maybeSingle();
  if (error) {
    console.error('[service:tasks] chore assignment delete failed', error);
    return fail(describeDbError(error, 'Could not remove that chore.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That chore could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'chores',
    action: 'delete',
    title: `Removed "${await choreTitle(scope, data.chore_id)}" from the chore board`,
    href: '/dashboard/chores',
    memberId: data.member_id,
    resourceId: data.id,
  });
  return ok({ id: data.id });
}

/** Open assignments (not yet done or approved), soonest due first. */
export async function listOpenChores(
  scope: ServiceScope,
  input: { memberId?: string | null; limit?: number } = {},
): Promise<ServiceResult<ChoreAssignment[]>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  let query = scope.db
    .from('chore_assignments')
    .select('*')
    .eq('family_id', scope.familyId)
    .in('status', ['todo', 'in_progress', 'submitted'])
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(limit);
  if (input.memberId) query = query.eq('member_id', input.memberId);

  const { data, error } = await query;
  if (error) {
    console.error('[service:tasks] open chores read failed', error);
    return fail(describeDbError(error, 'Could not load the chore board.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}
