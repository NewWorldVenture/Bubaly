// §7 — the household trail records the DOING, not just the making.
//
// After the trail landed it carried creates and deletes and nothing else. Every
// "tick it off, move it, clear it, snooze it" verb recorded NOTHING on the path a
// person takes — and ten of them recorded on Bubaly's path anyway, because the
// tool executor writes a line for any tool that does not declare
// `activityFrom: 'service'`. So the §7 third symptom survived one layer down, on
// exactly the actions a family performs most: Bubaly ticking off a to-do left two
// rows, a child ticking off the same to-do left none.
//
// The record moved INTO the services, which both actors share. These cases drive
// the real actions as a MEMBER — the actor that was invisible — and assert the
// household trail gains a line naming what happened.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { completeTodoAction } from '@/app/(app)/dashboard/todos/actions';
import { deleteChoreAssignmentAction, setChoreStatusAction } from '@/app/(app)/dashboard/chores/actions';
import { clearCheckedGroceriesAction, removeGroceryItemAction, setGroceryItemCheckedAction } from '@/app/(app)/dashboard/grocery/actions';
import { removeMealPlanAction } from '@/app/(app)/dashboard/meals/actions';
import { snoozeReminderAction } from '@/app/(app)/dashboard/reminders/actions';
import { undoCalendarEventsAction } from '@/app/(app)/dashboard/calendar/actions';

const FAMILY = 'family-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

/** The household trail rows this family gained, newest last. */
const trail = () => db.table('audit_logs').filter((r) => r.family_id === FAMILY);
/** The one line a case just produced, as the page would render its parts. */
function lastLine() {
  const row = trail()[trail().length - 1];
  const meta = (row?.metadata ?? {}) as { actor?: string; title?: string };
  return { action: row?.action, resource: row?.resource, actor: meta.actor, title: meta.title, actorId: row?.actor_id };
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      audit_logs: { resource_id: null, metadata: null },
      todo_items: { is_done: false, completed_at: null, assigned_to_id: null },
      chore_assignments: { status: 'todo', submitted_at: null, approved_at: null, due_at: null },
      chores: { requires_approval: true, points: 5 },
      grocery_items: { is_checked: false, quantity: null, category: null },
      meal_plans: { meal_id: null },
      family_reminders: { status: 'active', snoozed_until: null, member_id: null },
      calendar_events: { all_day: false, ends_at: null, assignee_id: null },
    },
  });
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

describe('ticking something off reaches the household trail', () => {
  it('records a to-do being ticked off, and being put back', async () => {
    db.seed('todo_items', [{ id: 'todo-1', family_id: FAMILY, title: 'Take out the bins' }]);

    expect((await completeTodoAction('todo-1', true)).ok).toBe(true);
    expect(lastLine()).toMatchObject({
      action: 'update', resource: 'tasks', actor: 'member',
      title: 'Ticked off "Take out the bins"', actorId: 'user-1',
    });

    expect((await completeTodoAction('todo-1', false)).ok).toBe(true);
    // Un-ticking is a change too; a trail that only recorded one direction would
    // show a task done that the family can see is not.
    expect(lastLine().title).toBe('Put "Take out the bins" back on the list');
  });

  it('records a chore finishing with the SETTLED status, not the requested one', async () => {
    // `requires_approval: false` settles on done. The trail must not say a chore
    // is waiting for a parent when no parent is owed a decision.
    db.seed('chores', [{ id: 'chore-1', family_id: FAMILY, title: 'Make your bed', requires_approval: false }]);
    db.seed('chore_assignments', [{ id: 'assign-1', family_id: FAMILY, chore_id: 'chore-1', member_id: 'member-2' }]);

    expect((await setChoreStatusAction('assign-1', 'submitted')).ok).toBe(true);
    expect(lastLine()).toMatchObject({ action: 'update', resource: 'chores', title: 'Finished "Make your bed"' });
  });

  it('says submitted when a parent still owes a decision', async () => {
    db.seed('chores', [{ id: 'chore-2', family_id: FAMILY, title: 'Mow the lawn', requires_approval: true }]);
    db.seed('chore_assignments', [{ id: 'assign-2', family_id: FAMILY, chore_id: 'chore-2', member_id: 'member-2' }]);

    expect((await setChoreStatusAction('assign-2', 'submitted')).ok).toBe(true);
    expect(lastLine().title).toBe('Submitted "Mow the lawn" for approval');
  });

  it('records picking a chore up and putting it back', async () => {
    db.seed('chores', [{ id: 'chore-3', family_id: FAMILY, title: 'Feed the dog' }]);
    db.seed('chore_assignments', [{ id: 'assign-3', family_id: FAMILY, chore_id: 'chore-3', member_id: 'member-2' }]);

    expect((await setChoreStatusAction('assign-3', 'in_progress')).ok).toBe(true);
    expect(lastLine().title).toBe('Started "Feed the dog"');

    expect((await setChoreStatusAction('assign-3', 'todo')).ok).toBe(true);
    expect(lastLine().title).toBe('Put "Feed the dog" back to do');
  });

  it('names the chore it removed, read before the row is gone', async () => {
    db.seed('chores', [{ id: 'chore-4', family_id: FAMILY, title: 'Wash the car' }]);
    db.seed('chore_assignments', [{ id: 'assign-4', family_id: FAMILY, chore_id: 'chore-4', member_id: 'member-2' }]);

    expect((await deleteChoreAssignmentAction('assign-4')).ok).toBe(true);
    expect(lastLine()).toMatchObject({ action: 'delete', title: 'Removed "Wash the car" from the chore board' });
  });
});

describe('the shopping list records what the shopper did', () => {
  beforeEach(() => {
    db.seed('grocery_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Groceries' }]);
  });

  it('records a tick-off both ways', async () => {
    db.seed('grocery_items', [{ id: 'item-1', family_id: FAMILY, list_id: 'list-1', name: 'Milk' }]);

    expect((await setGroceryItemCheckedAction('item-1', true)).ok).toBe(true);
    expect(lastLine()).toMatchObject({ action: 'update', resource: 'groceries', title: 'Ticked Milk off the shopping list' });

    expect((await setGroceryItemCheckedAction('item-1', false)).ok).toBe(true);
    expect(lastLine().title).toBe('Put Milk back on the shopping list');
  });

  it('names an item taken off the list, read back with the deleted row', async () => {
    db.seed('grocery_items', [{ id: 'item-2', family_id: FAMILY, list_id: 'list-1', name: 'Bread' }]);

    expect((await removeGroceryItemAction('item-2')).ok).toBe(true);
    expect(lastLine()).toMatchObject({ action: 'delete', title: 'Took Bread off the shopping list' });
  });

  it('counts what the cart clear actually removed', async () => {
    db.seed('grocery_items', [
      { id: 'i1', family_id: FAMILY, list_id: 'list-1', name: 'Eggs', is_checked: true },
      { id: 'i2', family_id: FAMILY, list_id: 'list-1', name: 'Butter', is_checked: true },
      { id: 'i3', family_id: FAMILY, list_id: 'list-1', name: 'Jam', is_checked: false },
    ]);

    expect((await clearCheckedGroceriesAction('list-1')).ok).toBe(true);
    expect(lastLine().title).toBe('Cleared 2 bought items from the shopping list');
  });

  it('writes no line when the clear removed nothing', async () => {
    // "Cleared 0 items" is not a change, and a trail full of them is noise.
    db.seed('grocery_items', [{ id: 'i4', family_id: FAMILY, list_id: 'list-1', name: 'Rice', is_checked: false }]);
    const before = trail().length;

    expect((await clearCheckedGroceriesAction('list-1')).ok).toBe(true);
    expect(trail()).toHaveLength(before);
  });
});

describe('the rest of the doing verbs', () => {
  it('names which dinner was cleared, not which recipe', async () => {
    db.seed('meal_plans', [{ id: 'plan-1', family_id: FAMILY, plan_date: '2026-09-08', meal_type: 'dinner' }]);

    expect((await removeMealPlanAction('plan-1')).ok).toBe(true);
    expect(lastLine()).toMatchObject({ action: 'delete', title: 'Cleared the dinner planned for 2026-09-08' });
  });

  it('records a snooze with how long it was snoozed for', async () => {
    db.seed('family_reminders', [{ id: 'rem-1', family_id: FAMILY, title: 'Call the dentist' }]);

    expect((await snoozeReminderAction('rem-1', 30)).ok).toBe(true);
    expect(lastLine()).toMatchObject({ action: 'update', resource: 'reminders', title: 'Snoozed "Call the dentist" for 30 minutes' });
  });

  it('records the routine Undo, which the batch create left unrecorded', async () => {
    db.seed('calendar_events', [
      { id: 'e1', family_id: FAMILY, title: 'Piano', starts_at: '2026-09-08T16:00:00.000Z' },
      { id: 'e2', family_id: FAMILY, title: 'Swim', starts_at: '2026-09-09T16:00:00.000Z' },
    ]);

    expect((await undoCalendarEventsAction(['e1', 'e2'])).ok).toBe(true);
    expect(lastLine()).toMatchObject({ action: 'delete', resource: 'calendar', title: 'Removed 2 events from the calendar' });
  });

  it('attributes every line to the person, never to Bubaly', async () => {
    // The whole point: these are a member's changes. If any recorded
    // `actor: 'ai'` the assistant would be taking credit for the family's work.
    //
    // The lines are produced HERE rather than read from earlier cases — each
    // case gets a fresh database, so asserting over an empty trail would pass
    // for the wrong reason.
    db.seed('todo_items', [{ id: 'todo-9', family_id: FAMILY, title: 'Water the plants' }]);
    db.seed('grocery_lists', [{ id: 'list-9', family_id: FAMILY, name: 'Groceries' }]);
    db.seed('grocery_items', [{ id: 'item-9', family_id: FAMILY, list_id: 'list-9', name: 'Coffee' }]);
    db.seed('family_reminders', [{ id: 'rem-9', family_id: FAMILY, title: 'Renew the passport' }]);

    await completeTodoAction('todo-9', true);
    await setGroceryItemCheckedAction('item-9', true);
    await snoozeReminderAction('rem-9', 15);

    const lines = trail();
    expect(lines).toHaveLength(3);
    expect(lines.every((r) => ((r.metadata ?? {}) as { actor?: string }).actor === 'member')).toBe(true);
    expect(lines.every((r) => r.actor_id === 'user-1')).toBe(true);
    expect(lines.every((r) => typeof ((r.metadata ?? {}) as { title?: string }).title === 'string')).toBe(true);
  });
});
