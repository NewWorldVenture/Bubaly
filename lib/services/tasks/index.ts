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
import { describeDbError, wroteNoRows, isMissingFunctionError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import {
  keyedProbe, sameId, sameInstant, withIdempotency, type IdempotencyProbe, type KeyedCreateOptions,
} from '../idempotency';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';
import { escapeLike } from '@/lib/supabase/escape-like';
import { readAllInChunks } from '@/lib/supabase/chunked-in';
import { readAllById } from '@/lib/supabase/read-all';
import { makeKey } from '../idempotency';
import { familyInstantIso, scopeNow } from '../scope';
import { choreRepeats, nextChoreDueAt } from '@/lib/chores/respawn';
import { getTranslations } from '@/lib/i18n/server';

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
/**
 * Get-or-create a family's to-do list — the oldest open one, or the oldest
 * open one with `name` — as ONE operation (DATA-007). The same race and the
 * same fix as `ensureDefaultGroceryListId` in lib/services/groceries: 0443's
 * `ensure_default_todo_list` serialises the read and the insert per family
 * (and per name, when one is asked for), and a database without it falls back
 * to the read-then-insert that ran before.
 *
 * `createdBy` is a family_members id — see the header note on this file.
 */
export async function ensureTodoListId(
  db: ServiceScope['db'],
  familyId: string,
  createdBy: string | null,
  name: string,
  matchName: boolean,
): Promise<{ id: string; error: null } | { id: null; error: unknown }> {
  const { data, error } = await db.rpc('ensure_default_todo_list', {
    p_family_id: familyId, p_name: name, p_match_name: matchName, p_created_by: createdBy,
  });
  if (!error && typeof data === 'string') return { id: data, error: null };
  if (error && !isMissingFunctionError(error)) return { id: null, error };

  let lookup = db
    .from('todo_lists')
    .select('id')
    .eq('family_id', familyId)
    .is('archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1);
  if (matchName) lookup = lookup.eq('name', name);
  const { data: existing, error: lookupError } = await lookup.maybeSingle();
  if (lookupError) return { id: null, error: lookupError };
  if (existing?.id) return { id: existing.id, error: null };

  const { data: created, error: createError } = await db
    .from('todo_lists')
    .insert({ family_id: familyId, name, created_by: createdBy })
    .select('id')
    .single();
  if (createError || !created) return { id: null, error: createError ?? new Error('To-do list was not created') };
  return { id: created.id, error: null };
}

export async function ensureTodoList(scope: ServiceScope, name?: string): Promise<ServiceResult<{ id: string }>> {
  const wanted = name?.trim() || DEFAULT_TODO_LIST_NAME;
  const list = await ensureTodoListId(scope.db, scope.familyId, scope.memberId, wanted, Boolean(name?.trim()));
  if (list.error || !list.id) {
    console.error('[service:tasks] to-do list get-or-create failed', list.error);
    return fail(describeDbError(list.error as never, 'Could not open your to-do lists.'), { code: SERVICE_CODES.db });
  }
  return ok({ id: list.id });
}

/**
 * A guest views the household's tasks and changes none of them ("view limited
 * shared events only"; the trust engine gives a guest's assistant `['view']`).
 * RLS on todo_items is plain `is_family_member` for insert and update and no
 * guest-write trigger covers the table, so this is where it is decided — for
 * the page's actions and for every assistant, approval and replay path alike.
 */
async function refuseGuestWrite(scope: ServiceScope): Promise<ServiceResult<never> | null> {
  if (scope.role !== 'guest') return null;
  return fail((await getTranslations())('actionRefusal.notAllowed'), { code: SERVICE_CODES.denied });
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

/** The columns a create chooses, as the insert below would write them. */
type TodoContent = Pick<TodoItem, 'list_id' | 'title' | 'notes' | 'due_date' | 'priority' | 'assigned_to_id' | 'tags'>;

/**
 * The columns on which a stored row differs from what this request would have
 * written — `ChangedRetry.drift` for a to-do. Names only: the values are a
 * family's task text and stay out of logs. `due_date` is a DATE, so a day key
 * compares as text.
 */
function contentDrift(stored: TodoItem, wanted: TodoContent): string[] {
  const drift: string[] = [];
  if (!sameId(stored.list_id, wanted.list_id)) drift.push('list_id');
  if (stored.title !== wanted.title) drift.push('title');
  if ((stored.notes ?? null) !== wanted.notes) drift.push('notes');
  if ((stored.due_date ?? null) !== wanted.due_date) drift.push('due_date');
  if (stored.priority !== wanted.priority) drift.push('priority');
  if (!sameId(stored.assigned_to_id, wanted.assigned_to_id)) drift.push('assigned_to_id');
  const storedTags = stored.tags ?? [];
  if (storedTags.length !== wanted.tags.length || storedTags.some((tag, i) => tag !== wanted.tags[i])) drift.push('tags');
  return drift;
}

/** A task's member reference must share its server-derived family scope. */
async function checkTodoAssignee(scope: ServiceScope, memberId: string | null): Promise<ServiceResult<null>> {
  if (memberId === null) return ok(null);
  if (typeof memberId !== 'string' || !memberId.trim()) {
    return fail('That task assignee could not be found.', { code: SERVICE_CODES.notFound });
  }
  try {
    const { data, error } = await scope.db.from('family_members')
      .select('id, family_id').eq('id', memberId).eq('family_id', scope.familyId).maybeSingle();
    if (error) return fail(describeDbError(error, 'Could not verify that task assignee.'), { code: SERVICE_CODES.db });
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.id !== memberId || data.family_id !== scope.familyId) {
      return fail('That task assignee could not be found.', { code: SERVICE_CODES.notFound });
    }
    return ok(null);
  } catch (error) {
    return fail(describeDbError(error, 'Could not verify that task assignee.'), { code: SERVICE_CODES.db });
  }
}

/** An explicit task list must share the task's server-derived family scope. */
async function checkTodoList(scope: ServiceScope, listId: string): Promise<ServiceResult<{ id: string }>> {
  if (typeof listId !== 'string' || !listId.trim()) {
    return fail('That task list could not be found.', { code: SERVICE_CODES.notFound });
  }
  try {
    const { data, error } = await scope.db.from('todo_lists')
      .select('id, family_id').eq('id', listId).eq('family_id', scope.familyId).maybeSingle();
    if (error) return fail(describeDbError(error, 'Could not verify that task list.'), { code: SERVICE_CODES.db });
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.id !== listId || data.family_id !== scope.familyId) {
      return fail('That task list could not be found.', { code: SERVICE_CODES.notFound });
    }
    return ok({ id: data.id });
  } catch (error) {
    return fail(describeDbError(error, 'Could not verify that task list.'), { code: SERVICE_CODES.db });
  }
}

export async function createTodo(
  scope: ServiceScope,
  input: CreateTodoInput,
  opts: KeyedCreateOptions = {},
): Promise<ServiceResult<TodoItem>> {
  const refused = await refuseGuestWrite(scope);
  if (refused) return refused;
  const title = input.title?.trim() ?? '';
  if (!title) return fail('A task needs a title.', { code: SERVICE_CODES.invalidInput });
  if (input.dueDate && !DAY_KEY.test(input.dueDate)) {
    return fail('A due date must look like 2026-09-05.', { code: SERVICE_CODES.invalidInput });
  }

  const assigneeId = input.assigneeId !== undefined ? input.assigneeId : scope.memberId;
  const assignee = await checkTodoAssignee(scope, assigneeId ?? null);
  if (!assignee.ok) return assignee;

  const list = input.listId ? await checkTodoList(scope, input.listId) : await ensureTodoList(scope);
  if (!list.ok) return list;

  const priority = input.priority && TODO_PRIORITIES.includes(input.priority) ? input.priority : 'medium';
  const wanted: TodoContent = {
    list_id: list.data.id,
    title,
    notes: input.notes?.trim() || null,
    due_date: input.dueDate ?? null,
    priority,
    assigned_to_id: assigneeId ?? null,
    tags: input.tags ?? [],
  };

  return withIdempotency<TodoItem>(
    scope,
    {
      operation: 'tasks.createTodo',
      input: { title, listId: list.data.id, dueDate: input.dueDate ?? null },
      // 0256: keyed on the call, so re-running a plan step returns its own
      // to-do while a family that really wants two "Pack the kit" rows gets two.
      find: keyedProbe(scope, 'todo_items', 'task'),
      // A person's press, not a plan step (see KeyedCreateOptions): a row found
      // under the key that differs from `wanted` is refused with copy naming the
      // task that really was saved, instead of being reported as "Task added".
      changedRetry: opts.rejectChangedRetry ? {
        drift: (stored) => contentDrift(stored, wanted),
        message: async (stored) => (await getTranslations())('tasks.alreadySavedAs', { title: stored.title }),
        id: (stored) => stored.id,
      } : undefined,
    },
    async (key) => {
      const { data, error } = await scope.db
        .from('todo_items')
        .insert({
          family_id: scope.familyId,
          // created_by references family_members(id) — see the header note;
          // so does assigned_to_id, inside `wanted`.
          created_by: scope.memberId,
          ...wanted,
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
  const refused = await refuseGuestWrite(scope);
  if (refused) return refused;
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

  if (Array.isArray(data) || typeof data !== 'object'
    || typeof data.id !== 'string' || !data.id.trim()
    || typeof data.family_id !== 'string' || !data.family_id.trim()
    || !sameId(data.id, todoId) || !sameId(data.family_id, scope.familyId)) {
    return fail('Could not update that task.', { code: SERVICE_CODES.db });
  }

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
  const refused = await refuseGuestWrite(scope);
  if (refused) return refused;
  const assignee = await checkTodoAssignee(scope, memberId);
  if (!assignee.ok) return assignee;
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
  const refused = await refuseGuestWrite(scope);
  if (refused) return refused;
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

  if (patch.assigneeId !== undefined) {
    const assignee = await checkTodoAssignee(scope, patch.assigneeId);
    if (!assignee.ok) return assignee;
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
    // Escaped once, at the call site — see lib/ai/tools/reminders.ts.
    const term = input.query.trim();
    query = query.ilike('title', `%${escapeLike(term)}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[service:tasks] to-do search failed', error);
    return fail(describeDbError(error, 'Could not load your tasks.'), { code: SERVICE_CODES.db });
  }
  if (data != null && !Array.isArray(data)) {
    return fail('Could not load your tasks.', { code: SERVICE_CODES.db });
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

/** The `chores` columns a create chooses; `icon` only when the caller named one. */
type ChoreContent =
  Pick<Chore, 'title' | 'description' | 'points' | 'priority' | 'recurrence' | 'due_at' | 'requires_approval'> & { icon?: string | null };

/**
 * `ChangedRetry.drift` for a chore and its assignment: the columns on which the
 * pair found under the key differs from what this create would have written.
 *
 * `due_at` is a `timestamptz`, compared as an instant. The board sends a bare
 * day (`<input type="date">`), which Postgres files at midnight in the
 * database's zone — UTC on Supabase — and `Date.parse` reads at UTC midnight
 * too, so an unchanged retry matches. Were those two zones ever to differ, the
 * cost is one true-worded "already saved" answer, never a lost write.
 */
function choreDrift(found: ChoreCreation, wanted: ChoreContent, assigneeId: string | null): string[] {
  const { chore, assignment } = found;
  const drift: string[] = [];
  if (chore.title !== wanted.title) drift.push('title');
  if ((chore.description ?? null) !== wanted.description) drift.push('description');
  if (chore.points !== wanted.points) drift.push('points');
  if (chore.priority !== wanted.priority) drift.push('priority');
  if (chore.recurrence !== wanted.recurrence) drift.push('recurrence');
  if (!sameInstant(chore.due_at, wanted.due_at)) drift.push('due_at');
  if (chore.requires_approval !== wanted.requires_approval) drift.push('requires_approval');
  if (wanted.icon !== undefined && (chore.icon ?? null) !== wanted.icon) drift.push('icon');
  if (!sameId(assignment?.member_id, assigneeId)) drift.push('member_id');
  return drift;
}

/**
 * A chore's due time as the instant it means. A zone-less value — the board's
 * date box, the planner's `localTime(...)`, the assistant's "Friday 17:00" — is
 * a reading on the FAMILY's clock. Written raw into the `timestamptz` it was
 * read in the database's zone (UTC): "Friday 5pm" showed as due at 10am in Los
 * Angeles and a date-only chore landed on the evening before.
 *
 * `createChore` applies it; `tasks.assignChore` applies it before calling
 * `requestChoreAssignment`, and `assignChore`'s other callers (`createChore`,
 * the respawn) already hand it an instant.
 */
export async function choreDueAt(scope: ServiceScope, value: string | null | undefined): Promise<ServiceResult<string | null>> {
  if (!value?.trim()) return ok(null);
  const at = familyInstantIso(value, scope.tz);
  return at ? ok(at) : fail((await getTranslations())('chores.dueAtUnreadable'), { code: SERVICE_CODES.invalidInput });
}

/**
 * Who may put a chore on someone's board: a parent or another adult, or the
 * system (a routine, a cron). This is the chores board's own rule
 * (`createChoreAction` is manager-only), held here because the assistant
 * reaches these writes without that action. The trust gate in front of the
 * assistant is not a stand-in for it: it lets a teen's low-risk writes through.
 * Approved work Bubaly filed keeps the approver's role (`scopeForApprovedWork`),
 * so a request a parent said yes to still runs.
 *
 * Deliberately NOT applied inside `assignChore`: a recurring chore's next
 * assignment is written through it when a child finishes their own.
 */
export const CHORES_ARE_SET_BY_A_MANAGER = 'Only a parent or another adult can add or assign chores.';

/**
 * `parent` and `adult` are `MANAGER_ROLES` (lib/constants/roles.ts), spelled
 * out because this module's dependency surface is pinned by tests that load it
 * on its own.
 */
export function mayManageChores(role: string | null | undefined): boolean {
  return role === 'system' || role === 'parent' || role === 'adult';
}

function refuseUnlessChoreManager(scope: ServiceScope): ServiceResult<never> | null {
  return mayManageChores(scope.role) ? null : fail(CHORES_ARE_SET_BY_A_MANAGER, { code: SERVICE_CODES.denied });
}

/**
 * Assign an existing chore to someone, as a request (the assistant's
 * `tasks.assignChore`). The manager rule above, then `assignChore`.
 */
export async function requestChoreAssignment(
  scope: ServiceScope,
  input: { choreId: string; memberId: string; dueAt?: string | null },
): Promise<ServiceResult<ChoreAssignment>> {
  const refused = refuseUnlessChoreManager(scope);
  if (refused) return refused;
  return assignChore(scope, input);
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
  opts: KeyedCreateOptions = {},
): Promise<ServiceResult<ChoreCreation>> {
  const refused = refuseUnlessChoreManager(scope);
  if (refused) return refused;
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
  const due = await choreDueAt(scope, input.dueAt);
  if (!due.ok) return due;
  const dueAt = due.data;

  /** The `chores` columns this create chooses, as the insert below writes them. */
  const choreRow: ChoreContent = {
    title,
    description: input.description?.trim() || null,
    points: input.points ?? 10,
    priority: input.priority ?? 'medium',
    recurrence: input.recurrence ?? 'none',
    due_at: dueAt,
    requires_approval: input.requiresApproval ?? true,
    ...(input.icon !== undefined ? { icon: input.icon } : {}),
  };

  return withIdempotency<ChoreCreation>(
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
      // The board's Add, not a plan step (see KeyedCreateOptions): a chore and
      // assignment found under the key that differ from this press are refused
      // with copy naming the chore that really was saved.
      changedRetry: opts.rejectChangedRetry ? {
        drift: (found) => choreDrift(found, choreRow, input.assigneeId ?? null),
        message: async (found) => (await getTranslations())('chores.alreadySavedAs', { title: found.chore.title }),
        id: (found) => found.chore.id,
      } : undefined,
    },
    async (key) => {
      const { data: chore, error } = await scope.db
        .from('chores')
        .insert({
          family_id: scope.familyId,
          ...choreRow,
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
          dueAt,
          idempotencyKey: key,
        });
        if (!assigned.ok) {
          // Covers the lost race as well as a genuine failure: either way this
          // chore has no assignment, and `withIdempotency` re-probes next.
          // A chore this call just created, so zero rows removed is a failed
          // rollback — an unassigned chore left in the family's list — not an
          // absence. Logged, not raised. Audit C1-S9-65.
          const { data: rolledBack, error: rollbackError } = await scope.db.from('chores').delete().eq('id', chore.id).eq('family_id', scope.familyId).select('id');
          if (rollbackError || wroteNoRows(rolledBack)) {
            console.error('[service:tasks] chore rollback failed', rollbackError ?? { choreId: chore.id, error: 'no rows deleted' });
          }
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

  const { data: assignee, error: assigneeError } = await scope.db
    .from('family_members')
    .select('id, family_id')
    .eq('id', input.memberId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (assigneeError) {
    console.error('[service:tasks] chore assignee lookup failed', assigneeError);
    return fail(describeDbError(assigneeError, 'Could not load that family member.'), { code: SERVICE_CODES.db });
  }
  if (
    !assignee || typeof assignee !== 'object' || Array.isArray(assignee)
    || typeof assignee.id !== 'string' || typeof assignee.family_id !== 'string'
    || assignee.id.toLowerCase() !== input.memberId.toLowerCase()
    || assignee.family_id.toLowerCase() !== scope.familyId.toLowerCase()
  ) {
    return fail('That person could not be found in this family.', { code: SERVICE_CODES.notFound });
  }

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

/** The key under which the assignment that follows `finished` is created: one successor per finished assignment, whoever asks and whenever. */
export const respawnKeyFor = (familyId: string, finishedAssignmentId: string) => makeKey(['tasks.respawnChore', familyId, finishedAssignmentId]);

/**
 * The next assignment of a recurring chore, once one of its assignments is
 * approved (or done, for a chore that needs no approval).
 *
 * A chore with a cadence was ONE assignment: approval closed it and nothing
 * created the next, so a daily "make your bed" was done once, ever, and the
 * board's Daily tab emptied after day one. This creates the following
 * assignment for the same child, due per `nextChoreDueAt`, unless they
 * already have an open one for the chore.
 *
 * It is keyed by the FINISHED assignment (`respawnKeyFor`) through 0256's
 * unique index — not by the due time it computes. The due time depends on the
 * clock (an assignment with no due time steps from now; a daily one steps past
 * midnight), so two approvals of one assignment arriving together, or on either
 * side of a boundary, computed two due times, two keys, and two next
 * assignments (audit note of 2026-10-04 07:45 UTC on #935). The finished
 * assignment is the one fact every path and every instant agree on: the
 * missions screen, the board, a double tap and the repair sweep all ask for
 * "the successor of asg-123" and the index answers once. A refused insert whose
 * key is already in the table reports `respawned: false` rather than failing.
 * `{ assignment: null }` when the chore does not repeat.
 */
export async function respawnChoreAssignment(
  scope: ServiceScope,
  input: { assignment: { id: string; chore_id: string; member_id: string; due_at: string | null }; recurrence: string | null | undefined },
): Promise<ServiceResult<{ assignment: ChoreAssignment | null; respawned: boolean }>> {
  const dueAt = nextChoreDueAt(input.assignment.due_at, input.recurrence, scopeNow(scope).toISOString(), scope.tz);
  if (!dueAt) return ok({ assignment: null, respawned: false });

  const { data: open, error: openError } = await scope.db
    .from('chore_assignments')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('chore_id', input.assignment.chore_id)
    .eq('member_id', input.assignment.member_id)
    .in('status', ['todo', 'in_progress'])
    .limit(1);
  if (openError) {
    console.error('[service:tasks] open assignment lookup failed', openError);
    return fail(describeDbError(openError, 'Could not check that chore.'), { code: SERVICE_CODES.db });
  }
  if (open && open.length > 0) return ok({ assignment: null, respawned: false });

  const idempotencyKey = respawnKeyFor(scope.familyId, input.assignment.id);
  const created = await assignChore(scope, { choreId: input.assignment.chore_id, memberId: input.assignment.member_id, dueAt, idempotencyKey });
  if (created.ok) return ok({ assignment: created.data, respawned: true });

  // `assignChore` folds every write error into one message. The one that is
  // not a failure here is 0256 refusing a key already written — by the other
  // approval screen, by this one a moment ago, or by the repair sweep.
  const { data: existing } = await scope.db
    .from('chore_assignments')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existing) return ok({ assignment: null, respawned: false });
  return created;
}

const OPEN_STATUSES = ['todo', 'in_progress'] as const;
const FINISHED_STATUSES = ['approved', 'done'] as const;

type FinishedRow = Pick<ChoreAssignment, 'id' | 'approved_at' | 'submitted_at' | 'created_at'>;
const finishedAt = (a: FinishedRow) => Date.parse(a.approved_at ?? a.submitted_at ?? a.created_at ?? '') || 0;

/**
 * The finished assignment the sweep repeats: the latest by `finishedAt`, the
 * first in id order on a tie. One definition, shared by the sweep and by the
 * delete's prediction of what the sweep will do (`sweepWouldRespawn`).
 */
function latestFinished<T extends FinishedRow>(rows: readonly T[]): T | null {
  let latest: T | null = null;
  for (const row of rows) if (!latest || finishedAt(row) > finishedAt(latest)) latest = row;
  return latest;
}

/**
 * The durable half of the respawn: every recurring chore whose child has
 * finished their latest assignment and has no open one gets its successor.
 *
 * `respawnChoreAssignment` runs inside the approval and the completion, after
 * the payout, and its failure is logged rather than thrown — the approval
 * stands. Before this, that log line was the end of it: a database hiccup at
 * that moment and the chore silently stopped repeating (audit note of
 * 2026-10-04 07:45 UTC on #935). This sweep finds exactly that state — a
 * finished latest assignment with nothing open after it — and asks for the
 * successor under the same key the approval would have used
 * (`respawnKeyFor(finished.id)`), so it creates nothing the approval already
 * created and nothing twice itself. The push-scan cron runs it for every
 * family every two hours. An assignment that is only submitted is waiting for
 * its approval, which respawns it; a member who has left the family gets
 * nothing new.
 */
export async function respawnMissingChoreAssignments(
  scope: ServiceScope,
): Promise<ServiceResult<{ respawned: number; skipped: number; failed: number }>> {
  const { data: chores, error: choresError } = await scope.db
    .from('chores')
    .select('id, recurrence')
    .eq('family_id', scope.familyId)
    .eq('is_active', true)
    .not('recurrence', 'is', null)
    .neq('recurrence', 'none');
  if (choresError) {
    console.error('[service:tasks] recurring chore read failed', choresError);
    return fail(describeDbError(choresError, 'Could not load the recurring chores.'), { code: SERVICE_CODES.db });
  }
  const recurring = (chores ?? []).filter((c) => choreRepeats(c.recurrence));
  if (recurring.length === 0) return ok({ respawned: 0, skipped: 0, failed: 0 });

  const { data: members, error: membersError } = await scope.db
    .from('family_members')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('is_active', true);
  if (membersError) {
    console.error('[service:tasks] member read failed', membersError);
    return fail(describeDbError(membersError, 'Could not load the family members.'), { code: SERVICE_CODES.db });
  }
  const active = new Set((members ?? []).map((m) => m.id));

  type Row = Pick<ChoreAssignment, 'id' | 'chore_id' | 'member_id' | 'due_at' | 'status' | 'approved_at' | 'submitted_at' | 'created_at'>;
  const { data: assignments, error: assignmentsError } = await readAllInChunks<Row, { message: string }>(
    recurring.map((c) => c.id),
    (chunk, from, to) => scope.db
      .from('chore_assignments')
      .select('id, chore_id, member_id, due_at, status, approved_at, submitted_at, created_at')
      .eq('family_id', scope.familyId)
      .in('chore_id', chunk)
      .in('status', [...OPEN_STATUSES, ...FINISHED_STATUSES])
      .order('id')
      .range(from, to),
  );
  if (assignmentsError) {
    console.error('[service:tasks] assignment read failed', assignmentsError);
    return fail(describeDbError(assignmentsError, 'Could not load the chore assignments.'), { code: SERVICE_CODES.db });
  }

  // Per (chore, child): anything open means nothing to do; otherwise the latest finished one is the predecessor.
  const byPair = new Map<string, { open: boolean; finished: Row[] }>();
  for (const a of assignments ?? []) {
    const key = `${a.chore_id}\u001F${a.member_id}`;
    const entry = byPair.get(key) ?? { open: false, finished: [] };
    if ((OPEN_STATUSES as readonly string[]).includes(a.status)) entry.open = true;
    else entry.finished.push(a);
    byPair.set(key, entry);
  }
  const recurrenceOf = new Map(recurring.map((c) => [c.id, c.recurrence]));

  let respawned = 0;
  let skipped = 0;
  let failed = 0;
  for (const { open, finished } of byPair.values()) {
    const latest = latestFinished(finished);
    if (open || !latest || !active.has(latest.member_id)) { skipped += 1; continue; }
    const res = await respawnChoreAssignment(scope, {
      assignment: { id: latest.id, chore_id: latest.chore_id, member_id: latest.member_id, due_at: latest.due_at },
      recurrence: recurrenceOf.get(latest.chore_id),
    });
    if (!res.ok) { failed += 1; console.error('[service:tasks] respawn sweep could not create a successor', { assignmentId: latest.id, error: res.error }); continue; }
    if (res.data.respawned) respawned += 1; else skipped += 1;
  }
  return ok({ respawned, skipped, failed });
}

/**
 * Why a member's own completion matched no row, read back after the write: the
 * assignment was handed to someone else, or a parent approved it, after the
 * checks were made. Both are refusals in the words the up-front checks use; a
 * row that is gone altogether is "not found", as it would have been before.
 */
async function refusedCompletion(scope: ServiceScope, assignmentId: string, ownMemberId: string): Promise<ServiceResult<never>> {
  const t = await getTranslations();
  const { data: current, error } = await scope.db
    .from('chore_assignments')
    .select('member_id, status')
    .eq('id', assignmentId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) console.error('[service:tasks] could not re-read a chore whose completion matched no row', { assignmentId, error });
  if (!error && !current) return fail('That chore could not be found.', { code: SERVICE_CODES.notFound });
  if (current && current.member_id === ownMemberId && current.status === 'approved') {
    return fail(t('chores.approvedIsSettled'), { code: SERVICE_CODES.denied });
  }
  if (current && current.member_id !== ownMemberId) return fail(t('chores.notYourAssignment'), { code: SERVICE_CODES.denied });
  // Unreadable, or changed in a way neither check names: still not settled by
  // this write, and nothing was written.
  return fail(t('chores.changedBeforeCompleting'), { code: SERVICE_CODES.denied });
}

/**
 * Mark an assignment done.
 *
 * A chore whose `requires_approval` is true goes to 'submitted', not 'done':
 * the parent approving it is what awards the points, and skipping that step
 * would let a child bank rewards unilaterally. Points and rewards themselves
 * stay in `lib/chores/server.ts`.
 *
 * A chore that needs NO approval settles here, so here is where a recurring
 * one comes back: `respawnChoreAssignment` creates the child's next
 * assignment once this one is done (an approved one is respawned by the
 * approval instead). Its failure is logged, not returned — the completion
 * stands.
 */
export async function completeChoreAssignment(scope: ServiceScope, assignmentId: string): Promise<ServiceResult<ChoreAssignment>> {
  const { data: assignment, error: readError } = await scope.db
    .from('chore_assignments')
    .select('id, chore_id, member_id, status')
    .eq('id', assignmentId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (readError) {
    console.error('[service:tasks] assignment lookup failed', readError);
    return fail(describeDbError(readError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }
  if (!assignment) return fail('That chore could not be found.', { code: SERVICE_CODES.notFound });

  // 0374's rule, in code: your own assignment, or a manager's decision. The
  // run executor writes with the service client, which RLS and 0374's
  // settled-row guard both let through (`auth.uid() is null`), so a teen's
  // assistant could mark a sibling's chore done — or pull an approved one, and
  // its points, back to "submitted". `can_manage_family` is parent or adult
  // (MANAGER_ROLES); a system actor (a cron) is the household itself.
  const decidesForAnyone = scope.role === 'parent' || scope.role === 'adult' || scope.role === 'system';
  const ownMemberId = decidesForAnyone ? null : scope.memberId ?? null;
  if (!decidesForAnyone) {
    if (!ownMemberId || assignment.member_id !== ownMemberId) {
      return fail((await getTranslations())('chores.notYourAssignment'), { code: SERVICE_CODES.denied });
    }
    if (assignment.status === 'approved') {
      return fail((await getTranslations())('chores.approvedIsSettled'), { code: SERVICE_CODES.denied });
    }
  }

  const { data: chore, error: choreError } = await scope.db
    .from('chores')
    .select('requires_approval, title, recurrence')
    .eq('id', assignment.chore_id)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (choreError) {
    console.error('[service:tasks] chore approval lookup failed', choreError);
    return fail(describeDbError(choreError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }

  const status: TaskStatus = chore?.requires_approval === false ? 'done' : 'submitted';
  let completion = scope.db
    .from('chore_assignments')
    .update({ status, submitted_at: new Date().toISOString() })
    .eq('id', assignmentId)
    .eq('family_id', scope.familyId);
  // The two checks above were made on the FIRST read. A parent approving the
  // chore, or handing it to a sibling, between that read and this write would
  // otherwise be overwritten: the approved chore — and its points — pulled
  // back to "submitted", or a sibling's chore marked done by someone else.
  // The run executor writes on the service client, where 0374's settled-row
  // trigger steps aside, so the write itself has to carry the rule.
  if (ownMemberId) completion = completion.eq('member_id', ownMemberId).neq('status', 'approved');
  const { data, error } = await completion.select('*').maybeSingle();
  if (error) {
    console.error('[service:tasks] assignment complete failed', error);
    return fail(describeDbError(error, 'Could not update that chore.'), { code: SERVICE_CODES.db });
  }
  if (!data) {
    if (!ownMemberId) return fail('That chore could not be found.', { code: SERVICE_CODES.notFound });
    return refusedCompletion(scope, assignmentId, ownMemberId);
  }

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
  if (status === 'done') {
    const respawn = await respawnChoreAssignment(scope, {
      assignment: { id: data.id, chore_id: data.chore_id, member_id: data.member_id, due_at: data.due_at },
      recurrence: chore?.recurrence,
    });
    if (!respawn.ok) {
      console.error('[service:tasks] next assignment of a recurring chore was not created', { assignmentId, error: respawn.error });
    }
  }
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

/**
 * A manager sends a submitted chore back for a redo: `submitted` → `rejected`.
 *
 * The board's Redo button sent 'rejected' through `setChoreStatusAction`, which
 * hands every status but 'submitted' to `setChoreProgress` — and that refuses
 * it, by design (the member vocabulary above must never grow a decision). So
 * every Redo failed with "That is not a status a member can set." and the
 * chore sat in the approvals queue. This is the decision's own door: manager
 * only, and only from 'submitted', so a chore approved or reopened in the
 * meantime is not overwritten by a stale screen.
 */
export async function rejectChoreAssignment(
  scope: ServiceScope,
  assignmentId: string,
): Promise<ServiceResult<ChoreAssignment>> {
  const refused = refuseUnlessChoreManager(scope);
  if (refused) return refused;

  const { data, error } = await scope.db
    .from('chore_assignments')
    .update({ status: 'rejected' })
    .eq('id', assignmentId)
    .eq('family_id', scope.familyId)
    .eq('status', 'submitted')
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:tasks] chore rejection failed', error);
    return fail(describeDbError(error, 'Could not update that chore.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That chore is no longer waiting for a decision. Refresh the board and try again.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'chores',
    action: 'update',
    title: `Sent "${await choreTitle(scope, data.chore_id)}" back for a redo`,
    href: '/dashboard/chores',
    memberId: data.member_id,
    resourceId: data.id,
  });
  return ok(data);
}

/** The statuses that keep a chore on a child's board: not yet decided, or sent back. */
const LIVE_STATUSES = ['todo', 'in_progress', 'submitted', 'rejected'] as const;

/**
 * What deleting this assignment does to the chore, for this child:
 *
 *   'retires'     a RECURRING chore that is only this child's, with nothing
 *                 else of it still live: the chore itself is retired
 *                 (`is_active = false`), which the sweep already skips.
 *   'comes-back'  a recurring chore that stays active — other children share
 *                 it, or this child still has another row of it — and the
 *                 push-scan sweep WILL give this child a new one once this row
 *                 is gone (`sweepWouldRespawn`): the board says so instead of
 *                 "removed".
 *   'stays'       anything else: a one-off or retired chore, or one the sweep
 *                 will not repeat for this child (something of it still open,
 *                 nothing finished to repeat, its next one already written, or
 *                 a child who has left the family).
 *
 * Deleting the row alone did not stop a repeating chore. The push-scan sweep
 * (`respawnMissingChoreAssignments`) finds a child with a finished assignment
 * of a repeating chore and nothing open, and asks for the successor under
 * `respawnKeyFor(finished)` — a key the deleted row held and the delete freed.
 * Retiring the chore stops that only when no other child has it, and a chore
 * shared by several children is the ordinary case, not a corner: /missions/new
 * shows one checkbox per kid and createChoreAction writes ONE chore with an
 * assignment per ticked child (the assistant's `tasks.assignChore` can add a
 * child to any chore too). Stopping it for one child alone needs a tombstone
 * the sweep respects — a task_status value such as `removed`, or a
 * per-(chore, member) stop table read by the sweep — which is a schema change
 * for the owner. Until it lands, 'comes-back' is said, not hidden.
 *
 * A submitted or rejected row keeps the chore on the board, so it keeps a
 * chore that is only this child's from being retired; it does NOT stop the
 * sweep, which counts only to-do and in-progress rows as open. Whether the
 * chore comes back is therefore the sweep's own question, asked of this one
 * (chore, child), not "is anything else of it live".
 */
type DeleteOutcome = 'retires' | 'comes-back' | 'stays';

async function deleteOutcome(
  scope: ServiceScope,
  target: { id: string; chore_id: string; member_id: string },
): Promise<ServiceResult<DeleteOutcome>> {
  const { data: chore, error: choreError } = await scope.db
    .from('chores')
    .select('id, recurrence, is_active')
    .eq('id', target.chore_id)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (choreError) {
    console.error('[service:tasks] chore read before delete failed', choreError);
    return fail(describeDbError(choreError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }
  if (!chore || chore.is_active === false || !choreRepeats(chore.recurrence)) return ok('stays');

  const { data: others, error: othersError } = await scope.db
    .from('chore_assignments')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('chore_id', target.chore_id)
    .neq('member_id', target.member_id)
    .limit(1);
  if (othersError) {
    console.error('[service:tasks] shared chore read before delete failed', othersError);
    return fail(describeDbError(othersError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }
  const shared = Boolean(others && others.length > 0);

  const { data: live, error: liveError } = await scope.db
    .from('chore_assignments')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('chore_id', target.chore_id)
    .eq('member_id', target.member_id)
    .neq('id', target.id)
    .in('status', [...LIVE_STATUSES])
    .limit(1);
  if (liveError) {
    console.error('[service:tasks] live chore read before delete failed', liveError);
    return fail(describeDbError(liveError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }
  if (!shared && !(live && live.length > 0)) return ok('retires');

  const respawns = await sweepWouldRespawn(scope, target);
  if (!respawns.ok) return respawns;
  return ok(respawns.data ? 'comes-back' : 'stays');
}

/**
 * Whether the push-scan sweep gives this child a new assignment of the chore
 * once `target` is gone: `respawnMissingChoreAssignments`'s own test, for one
 * (chore, child). Nothing of it open (to do or in progress — a submitted or
 * rejected row does not count), a finished one to repeat (the latest, as the
 * sweep picks it), that one's respawn key not held by a row that stays, and
 * the child still an active member of the family.
 */
async function sweepWouldRespawn(
  scope: ServiceScope,
  target: { id: string; chore_id: string; member_id: string },
): Promise<ServiceResult<boolean>> {
  const { data: open, error: openError } = await scope.db
    .from('chore_assignments')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('chore_id', target.chore_id)
    .eq('member_id', target.member_id)
    .neq('id', target.id)
    .in('status', [...OPEN_STATUSES])
    .limit(1);
  if (openError) {
    console.error('[service:tasks] open chore read before delete failed', openError);
    return fail(describeDbError(openError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }
  if (open && open.length > 0) return ok(false);

  const { rows: finished, error: finishedError } = await readAllById<FinishedRow>((after, limit) => {
    let q = scope.db
      .from('chore_assignments')
      .select('id, approved_at, submitted_at, created_at')
      .eq('family_id', scope.familyId)
      .eq('chore_id', target.chore_id)
      .eq('member_id', target.member_id)
      .neq('id', target.id)
      .in('status', [...FINISHED_STATUSES]);
    if (after) q = q.gt('id', after);
    return q.order('id').limit(limit);
  });
  if (finishedError) {
    console.error('[service:tasks] finished chore read before delete failed', finishedError);
    return fail(describeDbError(finishedError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }
  const latest = latestFinished(finished);
  if (!latest) return ok(false);

  // The sweep asks for the successor under this key; a row that stays holding it means 0256 refuses that insert.
  const { data: holder, error: holderError } = await scope.db
    .from('chore_assignments')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('idempotency_key', respawnKeyFor(scope.familyId, latest.id))
    .neq('id', target.id)
    .limit(1);
  if (holderError) {
    console.error('[service:tasks] respawn key read before delete failed', holderError);
    return fail(describeDbError(holderError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }
  if (holder && holder.length > 0) return ok(false);

  const { data: member, error: memberError } = await scope.db
    .from('family_members')
    .select('id')
    .eq('id', target.member_id)
    .eq('family_id', scope.familyId)
    .eq('is_active', true)
    .maybeSingle();
  if (memberError) {
    console.error('[service:tasks] member read before delete failed', memberError);
    return fail(describeDbError(memberError, 'Could not load that chore.'), { code: SERVICE_CODES.db });
  }
  return ok(Boolean(member));
}

/** Turn a chore on or off, confirmed: zero rows is a write that did not land. */
async function setChoreActive(scope: ServiceScope, choreId: string, isActive: boolean): Promise<boolean> {
  const { data, error } = await scope.db
    .from('chores')
    .update({ is_active: isActive })
    .eq('id', choreId)
    .eq('family_id', scope.familyId)
    .select('id');
  if (error || wroteNoRows(data)) {
    console.error('[service:tasks] chore active flag write failed', { choreId, isActive, error: error ?? 'no rows updated' });
    return false;
  }
  return true;
}

/**
 * Remove an assignment. The chore itself survives when it may still be
 * someone's; a recurring chore that was only this child's is retired with it,
 * so the respawn sweep does not put it back (`deleteOutcome`).
 *
 * `comesBack` is true when the respawn sweep WILL put the chore back on this
 * child's board: a repeating chore that stays active (other children share it,
 * or this child still has another row of it), which a delete cannot stop for
 * one child until the schema has a tombstone the sweep reads.
 */
export async function deleteChoreAssignment(
  scope: ServiceScope,
  assignmentId: string,
): Promise<ServiceResult<{ id: string; comesBack: boolean }>> {
  const { data: target, error: targetError } = await scope.db
    .from('chore_assignments')
    .select('id, chore_id, member_id')
    .eq('id', assignmentId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (targetError) {
    console.error('[service:tasks] chore assignment read before delete failed', targetError);
    return fail(describeDbError(targetError, 'Could not remove that chore.'), { code: SERVICE_CODES.db });
  }
  if (!target) return fail('That chore could not be found.', { code: SERVICE_CODES.notFound });

  // Retired BEFORE the delete, so a refused retirement leaves the board as it
  // was rather than removing a row the sweep will put back.
  const outcome = await deleteOutcome(scope, target);
  if (!outcome.ok) return outcome;
  const retires = outcome.data === 'retires';
  if (retires && !(await setChoreActive(scope, target.chore_id, false))) {
    return fail('Could not remove that chore.', { code: SERVICE_CODES.db });
  }

  // `chore_id` comes back with the deleted row, so naming it on the trail costs
  // no extra round trip here — the row is gone by the time we could ask again.
  const { data, error } = await scope.db
    .from('chore_assignments')
    .delete()
    .eq('id', assignmentId)
    .eq('family_id', scope.familyId)
    .select('id, chore_id, member_id')
    .maybeSingle();
  if (error || !data) {
    // The chore was retired for a delete that did not happen: put it back.
    if (retires) await setChoreActive(scope, target.chore_id, true);
  }
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
  return ok({ id: data.id, comesBack: outcome.data === 'comes-back' });
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
  if (data != null && !Array.isArray(data)) {
    return fail('Could not load the chore board.', { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}
