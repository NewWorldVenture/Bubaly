import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, click, has, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Focus Mode, the REAL module, its own reads, and the server actions it now
// finishes work through, against one in-memory database.
//
//   N9   it wrote `chore_assignments.status = 'submitted'` from the browser for
//        every chore, so a chore set to need no approval waited for one, the
//        toast said "submitted for approval", and a recurring chore's next
//        assignment was never created.
//   N17  it wrote `todo_items.is_done` alone — no `completed_at`, no activity —
//        so a task ticked here sorted behind every timestamped one in the
//        Completed list and was missing from the household trail.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
// The server side of the same session: the member's own context, and the same
// database through the server client.
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.app.userId },
    active: {
      familyId: h.app.familyId, role: (h.app as Record<string, unknown>).role, member: h.app.selfMember,
      family: { name: 'Fixture family', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { FocusModule } = await import('@/components/modules/focus-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const SELF = 'member-self';
let db: InMemorySupabase;

function as(role: string) {
  (h.app as Record<string, unknown>).role = role;
  h.app.selfMember = { id: SELF, display_name: 'Sam', role, is_active: true, color: null, birthday: null, family_id: FAMILY };
}
async function show(): Promise<ReactNode> {
  render(h.hooks, createElement(FocusModule));
  for (let pass = 0; pass < 5; pass++) await settle();
  return render(h.hooks, createElement(FocusModule));
}
const assignments = () => db.table('chore_assignments').filter((row) => row.chore_id === 'chore-cat');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', [{ id: SELF, family_id: FAMILY, user_id: h.app.userId, display_name: 'Sam', role: 'teen', is_active: true }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('N9: a chore that needs no approval is finished, and comes round again', () => {
  beforeEach(() => {
    as('teen');
    db.seed('chores', [{ id: 'chore-cat', family_id: FAMILY, title: 'Feed the cat', requires_approval: false, recurrence: 'weekly', points: 5, is_active: true }]);
    db.seed('chore_assignments', [{ id: 'asg-1', family_id: FAMILY, chore_id: 'chore-cat', member_id: SELF, status: 'todo', due_at: '2026-10-13T18:00:00Z' }]);
  });

  it('settles as done, says so, and creates next week\'s assignment', async () => {
    const tree = await show();
    expect(has(tree, 'Feed the cat')).toBe(true);
    await click(byName(tree, /Submit for approval/));

    expect(db.table('chore_assignments').find((row) => row.id === 'asg-1')).toMatchObject({ status: 'done' });
    expect(h.toasts.success).toContain(t('focusModule.choreDoneNoApprovalNeeded'));
    expect(h.toasts.success).not.toContain(t('focusModule.choreSubmittedForApproval'));
    const next = assignments().filter((row) => row.id !== 'asg-1');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ member_id: SELF, status: 'todo' });
    expect(String(next[0].due_at)).toMatch(/^2026-10-20/);
    expect(h.toasts.error).toEqual([]);
  });

  it('a chore that does need approval is still submitted for it', async () => {
    db.table('chores')[0].requires_approval = true;
    const tree = await show();
    await click(byName(tree, /Submit for approval/));
    expect(db.table('chore_assignments').find((row) => row.id === 'asg-1')).toMatchObject({ status: 'submitted' });
    expect(h.toasts.success).toContain(t('focusModule.choreSubmittedForApproval'));
    expect(assignments()).toHaveLength(1);
  });
});

describe('N17: a to-do ticked in Focus is finished like one ticked on the list', () => {
  it('stamps completed_at and leaves the activity trail', async () => {
    as('parent');
    db.seed('todo_items', [{ id: 'todo-1', family_id: FAMILY, title: 'Book the dentist', is_done: false, created_at: '2026-10-01T09:00:00Z' }]);
    const tree = await show();
    await click(byName(tree, /Mark done/));

    const todo = db.table('todo_items').find((row) => row.id === 'todo-1')!;
    expect(todo.is_done).toBe(true);
    expect(todo.completed_at).toBe('2026-10-13T12:00:00.000Z');
    // The household trail row the same tick on the To-dos page leaves.
    const trail = db.table('audit_logs').filter((row) => row.family_id === FAMILY);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ action: 'update', actor_id: h.app.userId });
    expect(h.toasts.success).toContain(t('focusModule.toDoSavedAsDone'));
  });
});
