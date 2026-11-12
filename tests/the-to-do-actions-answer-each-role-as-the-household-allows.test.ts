// Register B, group 6: the four to-do actions, called with VALID input as every
// role of household A and with household B's ids.
//
// The policy pinned here, and where it comes from:
//   * create / update / complete — any active member but a guest. The action
//     says so (refusesGuest, app/(app)/dashboard/todos/actions.ts) and so does
//     the service (refuseGuestWrite, lib/services/tasks/index.ts); the page is
//     read-only for a guest (todos-module.tsx `readOnly = role === 'guest'`);
//     RLS on todo_items is is_family_member for insert and update (0479).
//   * delete — a manager any task, a teen or child only one they created, a
//     guest or caregiver none (canDeleteTodo; 0479's todo_items_delete).
//   * every id — a row, a list, an assignee — must be household A's.
//
// Not pinned (see the PR body, "Needs an owner decision"): whether a teen or a
// child may rename, reassign or tick off a task someone ELSE wrote. The action
// and 0479 allow it ("Not tightened here"); lib/constants/roles.ts describes a
// teen as managing "their own tasks" and a child as viewing "their items". So
// the teen and child cases below act on their own task only.
//
// A child on a kid login reaches these actions with the same context as any
// child member (role 'child'); none of the four reads anything else.
//
// The fake database has no RLS, so every refusal asserted here is the action's
// or the service's own.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(MESSAGES, key, params),
}));

import {
  completeTodoAction, createTodoAction, deleteTodoAction, updateTodoAction,
} from '@/app/(app)/dashboard/todos/actions';

// Typed out, so a missing catalogue entry fails instead of matching its key.
const NOT_ALLOWED = 'Your account can’t make that change.';
const ONLY_A_PARENT = 'Only a parent/guardian can do this.';
const TASK_NOT_FOUND = 'That task could not be found.';
const LIST_NOT_FOUND = 'That task list could not be found.';
const ASSIGNEE_NOT_FOUND = 'That task assignee could not be found.';

const FAMILY_A = 'a0000000-0000-4000-8000-000000000001';
const FAMILY_B = 'b0000000-0000-4000-8000-000000000001';
const LIST_A = 'a0000000-0000-4000-8000-0000000000a1';
const LIST_B = 'b0000000-0000-4000-8000-0000000000b1';

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';
const MEMBER: Record<Role, string> = {
  parent: 'a0000000-0000-4000-8000-000000000101',
  adult: 'a0000000-0000-4000-8000-000000000102',
  teen: 'a0000000-0000-4000-8000-000000000103',
  child: 'a0000000-0000-4000-8000-000000000104',
  caregiver: 'a0000000-0000-4000-8000-000000000105',
  guest: 'a0000000-0000-4000-8000-000000000106',
};
const PARENT_B = 'b0000000-0000-4000-8000-000000000101';

/** One task in household A written by each role, and the parent's shared one. */
const OWN_TASK: Record<Role, string> = {
  parent: 'a0000000-0000-4000-8000-000000000201',
  adult: 'a0000000-0000-4000-8000-000000000202',
  teen: 'a0000000-0000-4000-8000-000000000203',
  child: 'a0000000-0000-4000-8000-000000000204',
  caregiver: 'a0000000-0000-4000-8000-000000000205',
  guest: 'a0000000-0000-4000-8000-000000000206',
};
const SHARED_TASK = OWN_TASK.parent;
const TASK_B = 'b0000000-0000-4000-8000-000000000201';
/** A B row whose created_by names A's teen — what a B member could insert, since 0479's insert check is family-only. */
const TASK_B_NAMING_A_TEEN = 'b0000000-0000-4000-8000-000000000202';

const ROLES: Role[] = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'];
const WRITERS: Role[] = ['parent', 'adult', 'teen', 'child', 'caregiver'];
const MANAGERS: Role[] = ['parent', 'adult'];

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

function signInAs(role: Role) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `c0000000-0000-4000-8000-00000000010${ROLES.indexOf(role) + 1}`, email: `${role}@example.com` },
    memberships: [],
    active: {
      familyId: FAMILY_A, role,
      family: { id: FAMILY_A, name: 'Household A', timezone: 'UTC' },
      member: { id: MEMBER[role], family_id: FAMILY_A, role, is_active: true },
    },
  });
}

const WATCHED = ['todo_items', 'todo_lists', 'agent_activity', 'audit_logs'] as const;
function snapshot(): Record<string, Row[]> {
  return Object.fromEntries(WATCHED.map((name) => [name, structuredClone(db.table(name))]));
}
const row = (id: string) => db.table('todo_items').find((r) => r.id === id);
const familyRows = (familyId: string) => db.table('todo_items').filter((r) => r.family_id === familyId);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      todo_items: {
        notes: null, is_done: false, priority: 'medium', due_date: null, tags: [],
        sort_order: 0, idempotency_key: null, completed_at: null, assigned_to_id: null,
      },
      todo_lists: { archived_at: null },
    },
  });
  db.seed('family_members', [
    ...ROLES.map((role) => ({ id: MEMBER[role], family_id: FAMILY_A, role, is_active: true })),
    { id: PARENT_B, family_id: FAMILY_B, role: 'parent', is_active: true },
  ]);
  db.seed('todo_lists', [
    { id: LIST_A, family_id: FAMILY_A, name: 'Tasks', created_by: MEMBER.parent },
    { id: LIST_B, family_id: FAMILY_B, name: 'Tasks', created_by: PARENT_B },
  ]);
  db.seed('todo_items', [
    ...ROLES.map((role) => ({
      id: OWN_TASK[role], family_id: FAMILY_A, list_id: LIST_A, title: `The ${role}'s task`,
      created_by: MEMBER[role], assigned_to_id: MEMBER[role],
    })),
    { id: TASK_B, family_id: FAMILY_B, list_id: LIST_B, title: 'Household B task', created_by: PARENT_B, assigned_to_id: PARENT_B },
    { id: TASK_B_NAMING_A_TEEN, family_id: FAMILY_B, list_id: LIST_B, title: 'Forged authorship', created_by: MEMBER.teen, assigned_to_id: PARENT_B },
  ]);
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

// ── createTodoAction ────────────────────────────────────────────────────────
describe('ACTION-52B73F1492C2 createTodoAction', () => {
  it.each(WRITERS)('ACTION-52B73F1492C2 a %s of household A adds a task to A, written as theirs', async (role) => {
    signInAs(role);
    const before = familyRows(FAMILY_A).length;
    const bBefore = structuredClone(familyRows(FAMILY_B));

    const result = await createTodoAction({ title: 'Pack the swim kit', listId: LIST_A, dueDate: '2026-09-10', priority: 'high' });

    expect(result).toEqual({ ok: true, id: expect.any(String) });
    const id = (result as { id: string }).id;
    expect(familyRows(FAMILY_A)).toHaveLength(before + 1);
    expect(row(id)).toMatchObject({
      family_id: FAMILY_A, list_id: LIST_A, title: 'Pack the swim kit', due_date: '2026-09-10',
      priority: 'high', created_by: MEMBER[role], assigned_to_id: MEMBER[role], is_done: false,
    });
    expect(familyRows(FAMILY_B)).toEqual(bBefore);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/todos');
  });

  it('ACTION-52B73F1492C2 a guest is refused before the database is opened, and nothing is written', async () => {
    signInAs('guest');
    const before = snapshot();

    expect(await createTodoAction({ title: 'Pack the swim kit', listId: LIST_A })).toEqual({ ok: false, error: NOT_ALLOWED });

    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(MANAGERS)('ACTION-52B73F1492C2 a %s cannot add a task to household B’s list', async (role) => {
    signInAs(role);
    const before = snapshot();

    expect(await createTodoAction({ title: 'Into B', listId: LIST_B })).toEqual({ ok: false, error: LIST_NOT_FOUND });

    expect(snapshot()).toEqual(before);
  });

  it.each(MANAGERS)('ACTION-52B73F1492C2 a %s cannot assign a new task to a member of household B', async (role) => {
    signInAs(role);
    const before = snapshot();

    expect(await createTodoAction({ title: 'For B', listId: LIST_A, assigneeId: PARENT_B })).toEqual({ ok: false, error: ASSIGNEE_NOT_FOUND });

    expect(snapshot()).toEqual(before);
  });
});

// ── updateTodoAction ────────────────────────────────────────────────────────
describe('ACTION-32A1ACCC3D46 updateTodoAction', () => {
  it.each(MANAGERS)('ACTION-32A1ACCC3D46 a %s renames and reassigns any task in household A', async (role) => {
    signInAs(role);
    const bBefore = structuredClone(familyRows(FAMILY_B));

    const result = await updateTodoAction(OWN_TASK.child, { title: 'Tidy the shoe rack', assigneeId: MEMBER.teen, dueDate: '2026-09-12' });

    expect(result).toEqual({ ok: true, id: OWN_TASK.child });
    expect(row(OWN_TASK.child)).toMatchObject({
      title: 'Tidy the shoe rack', assigned_to_id: MEMBER.teen, due_date: '2026-09-12', created_by: MEMBER.child, family_id: FAMILY_A,
    });
    expect(familyRows(FAMILY_B)).toEqual(bBefore);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/todos');
  });

  it.each(['teen', 'child', 'caregiver'] as const)('ACTION-32A1ACCC3D46 a %s edits a task they wrote', async (role) => {
    signInAs(role);
    const others = structuredClone(db.table('todo_items').filter((r) => r.id !== OWN_TASK[role]));

    const result = await updateTodoAction(OWN_TASK[role], { title: 'Renamed by me', notes: 'Before Friday' });

    expect(result).toEqual({ ok: true, id: OWN_TASK[role] });
    expect(row(OWN_TASK[role])).toMatchObject({ title: 'Renamed by me', notes: 'Before Friday', assigned_to_id: MEMBER[role] });
    expect(db.table('todo_items').filter((r) => r.id !== OWN_TASK[role])).toEqual(others);
  });

  it('ACTION-32A1ACCC3D46 a caregiver edits the household’s shared task', async () => {
    signInAs('caregiver');

    expect(await updateTodoAction(SHARED_TASK, { title: 'Book the dentist for Tuesday' })).toEqual({ ok: true, id: SHARED_TASK });

    expect(row(SHARED_TASK)).toMatchObject({ title: 'Book the dentist for Tuesday', created_by: MEMBER.parent });
  });

  it.each([OWN_TASK.guest, SHARED_TASK])('ACTION-32A1ACCC3D46 a guest cannot edit task %s, and nothing is written', async (id) => {
    signInAs('guest');
    const before = snapshot();

    expect(await updateTodoAction(id, { title: 'Renamed', assigneeId: MEMBER.guest })).toEqual({ ok: false, error: NOT_ALLOWED });

    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(WRITERS)('ACTION-32A1ACCC3D46 a %s cannot edit household B’s task: not found, nothing changes', async (role) => {
    signInAs(role);
    const before = snapshot();

    expect(await updateTodoAction(TASK_B, { title: 'Renamed from A' })).toEqual({ ok: false, error: TASK_NOT_FOUND });

    expect(snapshot()).toEqual(before);
  });

  it.each(MANAGERS)('ACTION-32A1ACCC3D46 a %s cannot hand an A task to a member of household B', async (role) => {
    signInAs(role);
    const before = snapshot();

    expect(await updateTodoAction(SHARED_TASK, { assigneeId: PARENT_B })).toEqual({ ok: false, error: ASSIGNEE_NOT_FOUND });

    expect(snapshot()).toEqual(before);
  });
});

// ── completeTodoAction ──────────────────────────────────────────────────────
describe('ACTION-A5AA67D27167 completeTodoAction', () => {
  it.each(WRITERS)('ACTION-A5AA67D27167 a %s ticks off the task assigned to them, and un-ticks it', async (role) => {
    signInAs(role);
    const others = structuredClone(db.table('todo_items').filter((r) => r.id !== OWN_TASK[role]));

    expect(await completeTodoAction(OWN_TASK[role], true)).toEqual({ ok: true, id: OWN_TASK[role] });
    expect(row(OWN_TASK[role])).toMatchObject({ is_done: true, completed_at: expect.any(String) });

    expect(await completeTodoAction(OWN_TASK[role], false)).toEqual({ ok: true, id: OWN_TASK[role] });
    expect(row(OWN_TASK[role])).toMatchObject({ is_done: false, completed_at: null });
    expect(db.table('todo_items').filter((r) => r.id !== OWN_TASK[role])).toEqual(others);
  });

  it.each(['adult', 'caregiver'] as const)('ACTION-A5AA67D27167 a %s ticks off the household’s shared task', async (role) => {
    signInAs(role);

    expect(await completeTodoAction(SHARED_TASK, true)).toEqual({ ok: true, id: SHARED_TASK });

    expect(row(SHARED_TASK)).toMatchObject({ is_done: true, completed_at: expect.any(String) });
  });

  it.each([OWN_TASK.guest, SHARED_TASK])('ACTION-A5AA67D27167 a guest cannot tick off task %s, and nothing is written', async (id) => {
    signInAs('guest');
    const before = snapshot();

    expect(await completeTodoAction(id, true)).toEqual({ ok: false, error: NOT_ALLOWED });

    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(WRITERS)('ACTION-A5AA67D27167 a %s cannot tick off household B’s task: not found, nothing changes', async (role) => {
    signInAs(role);
    const before = snapshot();

    expect(await completeTodoAction(TASK_B, true)).toEqual({ ok: false, error: TASK_NOT_FOUND });

    expect(snapshot()).toEqual(before);
    expect(row(TASK_B)).toMatchObject({ is_done: false, completed_at: null });
  });
});

// ── deleteTodoAction ────────────────────────────────────────────────────────
describe('ACTION-1139AA62CCF0 deleteTodoAction', () => {
  it.each(MANAGERS)('ACTION-1139AA62CCF0 a %s removes a task someone else wrote, and only that task', async (role) => {
    signInAs(role);
    const others = structuredClone(db.table('todo_items').filter((r) => r.id !== OWN_TASK.child));

    expect(await deleteTodoAction(OWN_TASK.child)).toEqual({ ok: true, id: OWN_TASK.child });

    expect(row(OWN_TASK.child)).toBeUndefined();
    expect(db.table('todo_items')).toEqual(others);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/todos');
  });

  it.each(['teen', 'child'] as const)('ACTION-1139AA62CCF0 a %s removes a task they wrote', async (role) => {
    signInAs(role);
    const others = structuredClone(db.table('todo_items').filter((r) => r.id !== OWN_TASK[role]));

    expect(await deleteTodoAction(OWN_TASK[role])).toEqual({ ok: true, id: OWN_TASK[role] });

    expect(db.table('todo_items')).toEqual(others);
  });

  it.each([
    ['teen', OWN_TASK.parent],
    ['teen', OWN_TASK.child],
    ['child', OWN_TASK.parent],
    ['child', OWN_TASK.teen],
  ] as const)('ACTION-1139AA62CCF0 a %s cannot remove task %s, written by someone else', async (role, id) => {
    signInAs(role);
    const before = snapshot();

    expect(await deleteTodoAction(id)).toEqual({ ok: false, error: ONLY_A_PARENT });

    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-1139AA62CCF0 a teen cannot remove a task they are assigned but did not write', async () => {
    signInAs('teen');
    row(SHARED_TASK)!.assigned_to_id = MEMBER.teen;
    const before = snapshot();

    expect(await deleteTodoAction(SHARED_TASK)).toEqual({ ok: false, error: ONLY_A_PARENT });

    expect(snapshot()).toEqual(before);
  });

  it.each([
    ['caregiver', OWN_TASK.caregiver],
    ['caregiver', SHARED_TASK],
    ['guest', OWN_TASK.guest],
    ['guest', SHARED_TASK],
  ] as const)('ACTION-1139AA62CCF0 a %s cannot remove task %s, even one they wrote', async (role, id) => {
    signInAs(role);
    const before = snapshot();

    expect(await deleteTodoAction(id)).toEqual({ ok: false, error: ONLY_A_PARENT });

    expect(snapshot()).toEqual(before);
  });

  it.each(MANAGERS)('ACTION-1139AA62CCF0 a %s cannot remove household B’s task: not found, nothing changes', async (role) => {
    signInAs(role);
    const before = snapshot();

    expect(await deleteTodoAction(TASK_B)).toEqual({ ok: false, error: TASK_NOT_FOUND });

    expect(snapshot()).toEqual(before);
  });

  it('ACTION-1139AA62CCF0 a teen cannot remove a household B row that names them as its author', async () => {
    signInAs('teen');
    const before = snapshot();

    expect(await deleteTodoAction(TASK_B_NAMING_A_TEEN)).toEqual({ ok: false, error: ONLY_A_PARENT });

    expect(snapshot()).toEqual(before);
  });
});
