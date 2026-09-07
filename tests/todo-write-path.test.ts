// The to-do list's Add button and Bubaly write through the same door.
//
// The third §7 surface, and the calendar's shape rather than the groceries':
// `createTodo` guards with `withIdempotency` against 0256's partial unique index
// on `todo_items`. Two children each needing "Pack the kit" are two
// compositions and get two rows; one parent pressing Add twice after a lost
// response is one composition and gets one.
//
// `updateTodo` and `deleteTodo` did not exist before this tranche — the service
// had `completeTodo` and `assignTodo` only — so the edit modal and the delete
// button had nowhere to go and went straight to PostgREST, filtering on `id`
// alone. Both are here, and both are family-scoped.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import {
  completeTodoAction, createTodoAction, deleteTodoAction, updateTodoAction,
} from '@/app/(app)/dashboard/todos/actions';

const FAMILY = 'family-1';
const OTHER_FAMILY = 'family-2';
const LIST = 'list-1';
const MEMBER = 'member-1';

const SAVE_ONE = '11111111-1111-4111-8111-111111111111';
const SAVE_TWO = '22222222-2222-4222-8222-222222222222';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

function todos(familyId = FAMILY) {
  return db.table('todo_items').filter((r) => r.family_id === familyId);
}

/** The clock the completion stamp is compared against; the suite must not depend on the runner's zone. */
const REAL_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Chicago'; });
afterAll(() => { if (REAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = REAL_TZ; });

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      todo_items: {
        notes: null, is_done: false, priority: 'medium', due_date: null,
        tags: [], sort_order: 0, idempotency_key: null, completed_at: null,
        assigned_to_id: null,
      },
      todo_lists: { archived_at: null },
    },
    // 0256, as written: partial, so hand-made rows with a null key are unconstrained.
    uniques: { todo_items: [['family_id', 'idempotency_key']] },
  });
  db.seed('todo_lists', [{ id: LIST, family_id: FAMILY, name: 'Tasks', created_by: MEMBER }]);
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: MEMBER },
    },
  });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

const kit = { title: 'Pack the swim kit', listId: LIST, dueDate: '2026-09-10' };

describe('a save that happens twice', () => {
  it('creates one task when Add is pressed again after a lost response', async () => {
    const first = await createTodoAction({ ...kit, submissionId: SAVE_ONE });
    const retry = await createTodoAction({ ...kit, submissionId: SAVE_ONE });

    expect(first.ok && retry.ok).toBe(true);
    expect(todos()).toHaveLength(1);
    expect(first.ok && retry.ok && retry.id).toBe(first.ok ? first.id : null);
  });

  it('creates one when both presses are in flight at once', async () => {
    // Either the probe catches it or 0256's index does, and the family gets one
    // task either way — which is why the assertion is on the rows, not the branch.
    const [a, b] = await Promise.all([
      createTodoAction({ ...kit, submissionId: SAVE_ONE }),
      createTodoAction({ ...kit, submissionId: SAVE_ONE }),
    ]);
    expect(a.ok, a.ok ? '' : a.error).toBe(true);
    expect(b.ok, b.ok ? '' : b.error).toBe(true);
    expect(todos()).toHaveLength(1);
  });

  it('creates both when two children need the same thing', async () => {
    // Composed separately, so different ids — a natural key on title would call
    // this a duplicate and silently drop one child's task.
    await createTodoAction({ ...kit, submissionId: SAVE_ONE });
    await createTodoAction({ ...kit, submissionId: SAVE_TWO });
    expect(todos()).toHaveLength(2);
  });

  it('still saves when the client sends no usable id', async () => {
    for (const submissionId of [undefined, 'not-a-uuid']) {
      await createTodoAction({ ...kit, submissionId });
    }
    expect(todos()).toHaveLength(2);
    expect(todos().every((r) => r.idempotency_key === null)).toBe(true);
  });
});

describe('what the server stores', () => {
  it('takes family_id from the session and created_by from the MEMBER, not the auth user', async () => {
    await createTodoAction({ ...kit, submissionId: SAVE_ONE });
    const row = todos()[0]!;
    expect(row.family_id).toBe(FAMILY);
    // todo_items.created_by references family_members(id) — NOT auth.users, which
    // is the FK mismatch the service layer was created to stop repeating.
    expect(row.created_by).toBe(MEMBER);
  });

  it('defaults the assignee to the acting member so a self-added task is not orphaned', async () => {
    await createTodoAction({ title: 'Book the dentist', listId: LIST, submissionId: SAVE_ONE });
    expect(todos()[0]!.assigned_to_id).toBe(MEMBER);
  });

  it('honours an explicit null assignee', async () => {
    await createTodoAction({ title: 'Anyone can do this', listId: LIST, assigneeId: null, submissionId: SAVE_ONE });
    expect(todos()[0]!.assigned_to_id).toBeNull();
  });

  it('drops an unrecognised priority instead of sending it on', async () => {
    await createTodoAction({ ...kit, priority: 'catastrophic', submissionId: SAVE_ONE });
    expect(todos()[0]!.priority).toBe('medium');
  });
});

describe('validation that used to live only in the browser', () => {
  it.each([['', 'empty'], ['   ', 'whitespace']])('refuses %j (%s) and writes nothing', async (title) => {
    const result = await createTodoAction({ title, listId: LIST, submissionId: SAVE_ONE });
    expect(result.ok).toBe(false);
    expect(todos()).toHaveLength(0);
  });

  it('refuses a due date that is not a day key', async () => {
    // `todo_items.due_date` is a DATE column; a timestamp would be silently
    // truncated by Postgres and a word rejected at the wire.
    const result = await createTodoAction({ ...kit, dueDate: 'next Friday', submissionId: SAVE_ONE });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/2026-09-05/);
    expect(todos()).toHaveLength(0);
  });

  it('refuses the same on an edit', async () => {
    const created = await createTodoAction({ ...kit, submissionId: SAVE_ONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await updateTodoAction(created.id, { dueDate: 'soon' });
    expect(result.ok).toBe(false);
    expect(todos()[0]!.due_date).toBe('2026-09-10');
  });
});

describe('editing and removing another household’s task', () => {
  beforeEach(() => {
    db.seed('todo_items', [
      { id: 'theirs', family_id: OTHER_FAMILY, list_id: 'their-list', title: 'Their errand', created_by: 'member-9' },
    ]);
  });

  it.each([
    ['delete', () => deleteTodoAction('theirs')],
    ['update', () => updateTodoAction('theirs', { title: 'Mine now' })],
    ['complete', () => completeTodoAction('theirs', true)],
  ])('cannot %s it — the service filters family_id, the client filtered id alone', async (_name, call) => {
    const result = await call();
    expect(result.ok).toBe(false);
    const row = db.table('todo_items').find((r) => r.id === 'theirs')!;
    expect(row.title).toBe('Their errand');
    expect(row.is_done).toBe(false);
    expect(todos(OTHER_FAMILY)).toHaveLength(1);
  });
});

describe('editing and removing the family’s own task', () => {
  it('updates only the fields the modal showed', async () => {
    const created = await createTodoAction({ ...kit, notes: 'goggles too', submissionId: SAVE_ONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await updateTodoAction(created.id, { title: 'Pack the swim kit (Thursday)' });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(todos()[0]!.title).toBe('Pack the swim kit (Thursday)');
    // Untouched, because the patch never mentioned them. A spread of the form's
    // state would have blanked both.
    expect(todos()[0]!.notes).toBe('goggles too');
    expect(todos()[0]!.due_date).toBe('2026-09-10');
  });

  it('refuses a patch that changes nothing rather than issuing an empty update', async () => {
    const created = await createTodoAction({ ...kit, submissionId: SAVE_ONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await updateTodoAction(created.id, {})).ok).toBe(false);
  });

  it('ticks a task off and stamps when, and un-ticks it back to null', async () => {
    const created = await createTodoAction({ ...kit, submissionId: SAVE_ONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect((await completeTodoAction(created.id, true)).ok).toBe(true);
    expect(todos()[0]!.is_done).toBe(true);
    // The stamp is the point of keeping this separate from a plain update: a done
    // task with no completion time is a row every "what got finished" read misses.
    expect(todos()[0]!.completed_at).toEqual(expect.any(String));

    expect((await completeTodoAction(created.id, false)).ok).toBe(true);
    expect(todos()[0]!.is_done).toBe(false);
    expect(todos()[0]!.completed_at).toBeNull();
  });

  it('deletes it', async () => {
    const created = await createTodoAction({ ...kit, submissionId: SAVE_ONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await deleteTodoAction(created.id)).ok).toBe(true);
    expect(todos()).toHaveLength(0);
  });

  it.each([
    ['delete', () => deleteTodoAction('')],
    ['update', () => updateTodoAction('', { title: 'x' })],
    ['complete', () => completeTodoAction('', true)],
  ])('refuses a %s with no id rather than issuing an unfiltered one', async (_name, call) => {
    await createTodoAction({ ...kit, submissionId: SAVE_ONE });
    expect((await call()).ok).toBe(false);
    expect(todos()).toHaveLength(1);
  });
});

describe('a caller who is not signed in', () => {
  it.each([
    ['create', () => createTodoAction({ ...kit, submissionId: SAVE_ONE })],
    ['update', () => updateTodoAction('some-id', { title: 'x' })],
    ['delete', () => deleteTodoAction('some-id')],
    ['complete', () => completeTodoAction('some-id', true)],
  ])('is redirected on %s, not handed an error toast', async (_name, call) => {
    // `requireUserContext` redirects by THROWING. Resolving the session inside an
    // action's try swallows that and answers `{ ok: false }`, so the person sees a
    // toast and stays put. The resolution sits outside the catch for this reason.
    mocks.requireUserContext.mockRejectedValueOnce(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' }),
    );
    await expect(call()).rejects.toThrow('NEXT_REDIRECT');
    expect(todos()).toHaveLength(0);
  });
});
