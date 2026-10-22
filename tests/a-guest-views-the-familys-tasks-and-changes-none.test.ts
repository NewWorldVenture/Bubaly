// S16 — a guest could add, rename, reassign and tick off any family to-do.
//
// /dashboard/todos has no role gate, and of the four to-do actions only
// deleteTodoAction asked who was calling (canDeleteTodo: "a guest or caregiver
// none"). createTodoAction, updateTodoAction and completeTodoAction went
// straight to the services, which did not ask either, and RLS on todo_items is
// plain is_family_member for insert and update with no guest-write trigger. So
// a guest — "view limited shared events only", and refused these very writes by
// its own assistant (the trust engine's guest capabilities are ['view']) — could
// rewrite the household's list.
//
// These drive the REAL actions and services against an in-memory database.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(MESSAGES, key, params),
}));

import { completeTodoAction, createTodoAction, updateTodoAction } from '@/app/(app)/dashboard/todos/actions';
import { assignTodo, completeTodo, createTodo, updateTodo } from '@/lib/services/tasks';
import { scopeFromUserContext } from '@/lib/services/scope';

const FAMILY = 'family-1';
const LIST = 'list-1';
const GUEST = 'member-guest';
const PARENT = 'member-parent';
const NOT_ALLOWED = MESSAGES['actionRefusal.notAllowed'];

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const ctx = (role: string, member: string) => ({
  user: { id: `user-${member}` },
  active: { familyId: FAMILY, role, family: { name: 'Family One', timezone: 'UTC' }, member: { id: member } },
});
const task = () => db.table('todo_items').find((row) => row.id === 'task-1')!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { todo_items: { notes: null, is_done: false, priority: 'medium', due_date: null, tags: [], sort_order: 0, idempotency_key: null, completed_at: null, assigned_to_id: null } },
  });
  db.seed('todo_lists', [{ id: LIST, family_id: FAMILY, name: 'Tasks', created_by: PARENT, sort_order: 0, archived_at: null }]);
  db.seed('family_members', [{ id: PARENT, family_id: FAMILY }, { id: GUEST, family_id: FAMILY }]);
  db.seed('todo_items', [{ id: 'task-1', family_id: FAMILY, list_id: LIST, title: 'Book the dentist', created_by: PARENT, assigned_to_id: PARENT }]);
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

describe('the to-do actions refuse a guest', () => {
  beforeEach(() => { mocks.requireUserContext.mockResolvedValue(ctx('guest', GUEST)); });

  it('a guest cannot add a task', async () => {
    const result = await createTodoAction({ title: 'Sneaky task', listId: LIST });
    expect(result).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(db.table('todo_items')).toHaveLength(1);
  });

  it('a guest cannot rename or reassign a task', async () => {
    const result = await updateTodoAction('task-1', { title: 'Renamed', assigneeId: GUEST });
    expect(result).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(task()).toMatchObject({ title: 'Book the dentist', assigned_to_id: PARENT });
  });

  it('a guest cannot tick a task off', async () => {
    const result = await completeTodoAction('task-1', true);
    expect(result).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(task()).toMatchObject({ is_done: false, completed_at: null });
  });
});

describe('the services refuse a guest on every path that reaches them', () => {
  const guestScope = () => scopeFromUserContext(ctx('guest', GUEST) as never, db);

  it.each([
    ['createTodo', () => createTodo(guestScope(), { title: 'Sneaky task', listId: LIST })],
    ['updateTodo', () => updateTodo(guestScope(), 'task-1', { title: 'Renamed' })],
    ['completeTodo', () => completeTodo(guestScope(), 'task-1', true)],
    ['assignTodo', () => assignTodo(guestScope(), 'task-1', GUEST)],
  ])('%s answers denied and writes nothing', async (_name, call) => {
    const result = await call();
    expect(result).toMatchObject({ ok: false, code: 'denied', error: NOT_ALLOWED });
    expect(db.table('todo_items')).toHaveLength(1);
    expect(task()).toMatchObject({ title: 'Book the dentist', is_done: false, assigned_to_id: PARENT });
  });
});

describe('every other role keeps the list it works on', () => {
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'])('a %s can still tick a task off', async (role) => {
    mocks.requireUserContext.mockResolvedValue(ctx(role, PARENT));
    expect(await completeTodoAction('task-1', true)).toEqual({ ok: true, id: 'task-1' });
    expect(task().is_done).toBe(true);
  });
});
