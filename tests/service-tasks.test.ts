// Behavioural tests for the tasks service. The headline assertion is the
// foreign key: `todo_lists.created_by` and `todo_items.created_by` reference
// `public.family_members(id)` (migration 0015) while `chores.created_by`
// references `auth.users` (0002). Writing the auth user id into the todo
// tables — which `lib/assistant/tools.ts` does today — violates the FK, so the
// assistant's first "add a to-do" never saves. These tests lock the correct id
// into each column so the bug cannot come back.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  assignChore,
  assignTodo,
  completeChoreAssignment,
  completeTodo,
  createChore,
  createTodo,
  ensureTodoList,
  listOpenChores,
  searchTodos,
} from '@/lib/services/tasks';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call, index: number) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    const index = calls.push(call) - 1;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, ilike: chain, or: chain,
      eq: filter, is: filter, in: filter,
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call, index)),
      maybeSingle: () => Promise.resolve(respond(call, index)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call, index)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db,
    familyId: 'fam-1',
    userId: 'auth-user-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'member',
    tz: 'America/New_York',
    now: NOW,
    ...extra,
  };
}

describe('ensureTodoList', () => {
  it('reuses the oldest un-archived list instead of creating a second one', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'list-1' }, error: null }));
    const res = await ensureTodoList(scopeWith(db));
    expect(res).toEqual({ ok: true, data: { id: 'list-1', created: false } });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', archived_at: null });
  });

  it('creates the list with the MEMBER id, not the auth user id', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert'
      ? { data: { id: 'list-new' }, error: null }
      : { data: null, error: null }));
    const res = await ensureTodoList(scopeWith(db));
    expect(res).toEqual({ ok: true, data: { id: 'list-new', created: true } });
    // todo_lists.created_by references family_members(id) — migration 0015.
    expect(calls.find((c) => c.kind === 'insert')?.payload).toEqual({
      family_id: 'fam-1', name: 'To-Do', created_by: 'member-1',
    });
  });

  it('surfaces a lookup failure instead of blindly creating a duplicate list', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: { message: 'connection reset' } }));
    const res = await ensureTodoList(scopeWith(db));
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });
});

describe('createTodo', () => {
  it('writes member ids into created_by and assigned_to_id', async () => {
    const { db, calls } = makeDb((call) => (call.table === 'todo_lists'
      ? { data: { id: 'list-1' }, error: null }
      : { data: { id: 'todo-1', title: 'Pack lunches' }, error: null }));

    const res = await createTodo(scopeWith(db), { title: '  Pack lunches ', dueDate: '2026-09-06' });
    expect(res.ok).toBe(true);
    const insert = calls.find((c) => c.table === 'todo_items' && c.kind === 'insert');
    expect(insert?.payload).toMatchObject({
      family_id: 'fam-1',
      list_id: 'list-1',
      title: 'Pack lunches',
      created_by: 'member-1',
      assigned_to_id: 'member-1',
      due_date: '2026-09-06',
      priority: 'medium',
    });
  });

  it('honours an explicit assignee and an explicit unassignment', async () => {
    const { db, calls } = makeDb((call) => (call.table === 'todo_lists'
      ? { data: { id: 'list-1' }, error: null }
      : { data: { id: 'todo-1' }, error: null }));

    await createTodo(scopeWith(db), { title: 'Shared task', assigneeId: null });
    const insert = calls.find((c) => c.table === 'todo_items' && c.kind === 'insert');
    expect((insert?.payload as Record<string, unknown>).assigned_to_id).toBeNull();
  });

  it('rejects a due date that is not a day key', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await createTodo(scopeWith(db), { title: 'Pay rent', dueDate: 'friday' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('surfaces an insert failure as ok:false', async () => {
    const { db } = makeDb((call) => (call.table === 'todo_lists'
      ? { data: { id: 'list-1' }, error: null }
      : { data: null, error: { code: '23503', message: 'insert or update on table "todo_items" violates foreign key constraint' } }));
    const res = await createTodo(scopeWith(db), { title: 'Pack lunches' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('db');
  });
});

describe('completeTodo / assignTodo / searchTodos', () => {
  it('scopes completion to the family', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'todo-1', is_done: true }, error: null }));
    const res = await completeTodo(scopeWith(db), 'todo-1');
    expect(res.ok).toBe(true);
    expect(calls[0].filters).toMatchObject({ id: 'todo-1', family_id: 'fam-1' });
    expect((calls[0].payload as Record<string, unknown>).is_done).toBe(true);
  });

  it('reports a todo from another family as not found', async () => {
    const { db } = makeDb(() => ({ data: null, error: null }));
    const res = await assignTodo(scopeWith(db), 'todo-x', 'member-2');
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('applies the family filter and the requested facets when searching', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    await searchTodos(scopeWith(db), { done: false, assigneeId: 'member-2', dueBefore: '2026-09-10' });
    expect(calls[0].filters).toMatchObject({
      family_id: 'fam-1', is_done: false, assigned_to_id: 'member-2', 'lte:due_date': '2026-09-10',
    });
  });
});

describe('createChore', () => {
  it('writes the AUTH USER id into chores.created_by', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'chore-1', title: 'Dishes', due_at: null }, error: null }));
    const res = await createChore(scopeWith(db), { title: 'Dishes', points: 20 });
    expect(res.ok).toBe(true);
    // chores.created_by references auth.users (0002) — the opposite of todo_items.
    expect(calls.find((c) => c.table === 'chores' && c.kind === 'insert')?.payload).toMatchObject({
      family_id: 'fam-1', title: 'Dishes', points: 20, created_by: 'auth-user-1', requires_approval: true,
    });
  });

  it('refuses negative points rather than clamping them', async () => {
    // The chat tool this service replaced clamped with `Math.max(0, …)`, and the
    // clamp did not survive the move to the registry — `points` was
    // `z.number().int().nullish()` with no floor, so a model that said "-5
    // points" wrote a chore that TAKES points away for doing it. Refused rather
    // than clamped: silently turning -5 into 0 answers a request nobody made,
    // and the person asking never learns their number was ignored.
    const { db, calls } = makeDb(() => ({ data: { id: 'chore-1', title: 'Dishes', due_at: null }, error: null }));
    const res = await createChore(scopeWith(db), { title: 'Dishes', points: -5 });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls.some((c) => c.table === 'chores' && c.kind === 'insert'), 'nothing should be stored').toBe(false);
  });

  it('still allows a zero-point chore, which is a real thing a family wants', async () => {
    // Not everything a household asks for carries a reward, and a floor that
    // refused 0 would be a different bug from the one above.
    const { db, calls } = makeDb(() => ({ data: { id: 'chore-1', title: 'Tidy up', due_at: null }, error: null }));
    const res = await createChore(scopeWith(db), { title: 'Tidy up', points: 0 });
    expect(res.ok).toBe(true);
    expect(calls.find((c) => c.table === 'chores' && c.kind === 'insert')?.payload).toMatchObject({ points: 0 });
  });

  it('assigns in the same call and passes the member id', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'chores' && call.kind === 'insert') return { data: { id: 'chore-1', title: 'Dishes', due_at: null }, error: null };
      if (call.table === 'chores') return { data: { id: 'chore-1', due_at: null }, error: null };
      return { data: { id: 'assign-1', member_id: 'member-2' }, error: null };
    });

    const res = await createChore(scopeWith(db), { title: 'Dishes', assigneeId: 'member-2' });
    expect(res.ok).toBe(true);
    expect(calls.find((c) => c.table === 'chore_assignments')?.payload).toMatchObject({
      family_id: 'fam-1', chore_id: 'chore-1', member_id: 'member-2', status: 'todo',
    });
  });

  it('rolls the chore back when the assignment fails, leaving no orphan', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'chores' && call.kind === 'insert') return { data: { id: 'chore-1', title: 'Dishes', due_at: null }, error: null };
      if (call.table === 'chores' && call.kind === 'delete') return { data: null, error: null };
      if (call.table === 'chores') return { data: { id: 'chore-1', due_at: null }, error: null };
      return { data: null, error: { message: 'assignment failed' } };
    });

    const res = await createChore(scopeWith(db), { title: 'Dishes', assigneeId: 'member-2' });
    expect(res.ok).toBe(false);
    const rollback = calls.find((c) => c.table === 'chores' && c.kind === 'delete');
    expect(rollback?.filters).toMatchObject({ id: 'chore-1', family_id: 'fam-1' });
  });
});

describe('assignChore', () => {
  it('refuses to write an assignment for a chore outside the family', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await assignChore(scopeWith(db), { choreId: 'chore-elsewhere', memberId: 'member-2' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls.some((c) => c.table === 'chore_assignments')).toBe(false);
  });

  it('requires a member — chore_assignments.member_id is NOT NULL', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await assignChore(scopeWith(db), { choreId: 'chore-1', memberId: '' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('completeChoreAssignment', () => {
  it('submits for approval when the chore requires it', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'chore_assignments' && call.kind === 'select') return { data: { id: 'assign-1', chore_id: 'chore-1' }, error: null };
      if (call.table === 'chores') return { data: { requires_approval: true }, error: null };
      return { data: { id: 'assign-1', status: 'submitted' }, error: null };
    });
    const res = await completeChoreAssignment(scopeWith(db), 'assign-1');
    expect(res.ok).toBe(true);
    expect((calls.find((c) => c.kind === 'update')?.payload as Record<string, unknown>).status).toBe('submitted');
  });

  it('marks it done outright when no approval is required', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'chore_assignments' && call.kind === 'select') return { data: { id: 'assign-1', chore_id: 'chore-1' }, error: null };
      if (call.table === 'chores') return { data: { requires_approval: false }, error: null };
      return { data: { id: 'assign-1', status: 'done' }, error: null };
    });
    const res = await completeChoreAssignment(scopeWith(db), 'assign-1');
    expect(res.ok).toBe(true);
    expect((calls.find((c) => c.kind === 'update')?.payload as Record<string, unknown>).status).toBe('done');
  });
});

describe('listOpenChores', () => {
  it('asks only for unfinished work in this family', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    await listOpenChores(scopeWith(db), { memberId: 'member-2' });
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', member_id: 'member-2' });
    expect(calls[0].filters.status).toEqual(['todo', 'in_progress', 'submitted']);
  });

  it('fails closed on a read error rather than reporting an empty board', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'timeout' } }));
    const res = await listOpenChores(scopeWith(db));
    expect(res.ok).toBe(false);
  });
});
