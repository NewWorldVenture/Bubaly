// A removed member gets no new assignments.
//
// family.listMembers { include_inactive: true } hands the model a removed
// member's id; resolveAssigneeId accepted any id in the family, active or not
// (its own comment said "write paths that need a current member check that
// too" — none did); and checkTodoAssignee selected `id, family_id` only. So
// tasks.createTodo { assignee_id } wrote a todo_items row assigned to a person
// no longer in the family, invisible in every active member's "mine" view,
// and the same resolver fed reminders, calendar, home, moving and trips. The
// write tools now ask the resolver for a CURRENT member, and the tasks service
// refuses an inactive assignee on its own, so a direct caller cannot assign to
// a removed member either. Read tools keep resolving former members, so a
// search for their old items still works.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn(async () => undefined) }));

const { resolveAssigneeId } = await import('@/lib/ai/tools/family');
const { taskTools } = await import('@/lib/ai/tools/tasks');
const { reminderTools } = await import('@/lib/ai/tools/reminders');
const { calendarTools } = await import('@/lib/ai/tools/calendar');
const { memoryTools } = await import('@/lib/ai/tools/memory');
const { documentTools } = await import('@/lib/ai/tools/documents');
const { createTodo, assignTodo } = await import('@/lib/services/tasks');

const FAMILY = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const PARENT = 'cccccccc-cccc-4ccc-8ccc-000000000001';
const AVA = 'cccccccc-cccc-4ccc-8ccc-000000000002';
const EX = 'cccccccc-cccc-4ccc-8ccc-000000000003';
const LIST = 'eeeeeeee-eeee-4eee-8eee-000000000001';
const TODO = 'dddddddd-dddd-4ddd-8ddd-000000000001';

const tool = (tools: { name: string }[], name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found as unknown as { execute: (scope: ServiceScope, input: unknown) => Promise<{ ok: boolean; code?: string; error?: string }>; input: { parse: (v: unknown) => unknown } };
};

let db: InMemorySupabase;
let scope: ServiceScope;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>();
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, display_name: 'Jordan', role: 'parent', is_active: true },
    { id: AVA, family_id: FAMILY, display_name: 'Ava', role: 'child', is_active: true },
    // Removed last month: REMOVED_MEMBER_PATCH leaves the row, inactive.
    { id: EX, family_id: FAMILY, display_name: 'Ex', role: 'guest', is_active: false },
  ]);
  db.seed('todo_lists', [{ id: LIST, family_id: FAMILY, name: 'Family', is_default: true }]);
  db.seed('todo_items', [{ id: TODO, family_id: FAMILY, list_id: LIST, title: 'Return the library books', assigned_to_id: EX, is_done: false, priority: 'medium', tags: [] }]);
  scope = { db: db as unknown as ServiceScope['db'], familyId: FAMILY, userId: 'auth-parent', memberId: PARENT, role: 'parent', actorKind: 'ai', tz: 'UTC', now: new Date('2026-10-10T12:00:00Z') };
});

describe('resolveAssigneeId', () => {
  it('refuses a removed member\'s id for a write, and says why', async () => {
    expect(await resolveAssigneeId(scope, { assignee_id: EX }, { requireActive: true }))
      .toMatchObject({ ok: false, code: 'not_found', error: 'That person is no longer in this family.' });
  });

  it('still resolves them for a read, so a search for their old items works', async () => {
    expect(await resolveAssigneeId(scope, { assignee_id: EX })).toEqual({ ok: true, data: EX });
  });

  it('resolves a current member either way, and refuses another household\'s id either way', async () => {
    expect(await resolveAssigneeId(scope, { assignee_id: AVA }, { requireActive: true })).toEqual({ ok: true, data: AVA });
    expect(await resolveAssigneeId(scope, { assignee_id: 'nobody' }, { requireActive: true })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('the write tools', () => {
  it('tasks.createTodo writes nothing for a removed assignee, and a to-do for a current one', async () => {
    const create = tool(taskTools, 'tasks.createTodo');
    const refused = await create.execute(scope, create.input.parse({ title: 'Pack the lunches', assignee_id: EX }));
    expect(refused).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('todo_items').filter((t) => t.title === 'Pack the lunches')).toEqual([]);

    const made = await create.execute(scope, create.input.parse({ title: 'Pack the lunches', assignee_id: AVA }));
    expect(made.ok).toBe(true);
    expect(db.table('todo_items').find((t) => t.title === 'Pack the lunches')).toMatchObject({ assigned_to_id: AVA, family_id: FAMILY });
  });

  it('tasks.assignTodo does not move an existing to-do onto a removed member', async () => {
    const assign = tool(taskTools, 'tasks.assignTodo');
    db.table('todo_items')[0].assigned_to_id = AVA;
    expect(await assign.execute(scope, assign.input.parse({ todo_id: TODO, assignee_id: EX }))).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('todo_items')[0].assigned_to_id).toBe(AVA);
  });

  it('reminders.create and calendar.createEvent refuse before anything is written', async () => {
    const reminder = tool(reminderTools, 'reminders.create');
    expect(await reminder.execute(scope, reminder.input.parse({ title: 'Dentist', remind_at: '2026-10-12T09:00:00Z', assignee_id: EX }))).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('family_reminders')).toEqual([]);

    const event = tool(calendarTools, 'calendar.createEvent');
    expect(await event.execute(scope, event.input.parse({ title: 'Recital', starts_at: '2026-10-12T18:00:00Z', assignee_id: EX }))).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('calendar_events')).toEqual([]);
  });

  it('memory.remember and documents.linkToVacation do not file a new fact or trip document under them', async () => {
    const remember = tool(memoryTools, 'memory.remember');
    expect(await remember.execute(scope, remember.input.parse({ key: 'Shoe size', content: 'US 9', member_id: EX, asked_for: true }))).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('family_facts')).toEqual([]);
    expect(db.table('family_playbook_suggestions')).toEqual([]);

    const link = tool(documentTools, 'documents.linkToVacation');
    expect(await link.execute(scope, link.input.parse({ document_id: 'doc-1', vacation_id: 'trip-1', member_id: EX }))).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('vacation_documents')).toEqual([]);
  });

  it('tasks.searchTodos still finds the removed member\'s old items (control)', async () => {
    const search = tool(taskTools, 'tasks.searchTodos');
    const res = await search.execute(scope, search.input.parse({ assignee_id: EX })) as { ok: boolean; data?: { todos: { id: string }[] } };
    expect(res.ok).toBe(true);
    expect(res.data?.todos.map((t) => t.id)).toEqual([TODO]);
  });
});

describe('the tasks service, called directly', () => {
  it('createTodo and assignTodo refuse a removed assignee on their own', async () => {
    expect(await createTodo(scope, { title: 'Walk the dog', listId: LIST, assigneeId: EX })).toMatchObject({ ok: false, code: 'not_found', error: 'That person is no longer in this family.' });
    expect(db.table('todo_items').filter((t) => t.title === 'Walk the dog')).toEqual([]);
    db.table('todo_items')[0].assigned_to_id = AVA;
    expect(await assignTodo(scope, TODO, EX)).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('todo_items')[0].assigned_to_id).toBe(AVA);
  });

  it('and still take a current member, or nobody (control)', async () => {
    expect((await createTodo(scope, { title: 'Walk the dog', listId: LIST, assigneeId: AVA })).ok).toBe(true);
    expect((await createTodo(scope, { title: 'Water the plants', listId: LIST, assigneeId: null })).ok).toBe(true);
  });
});
