import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { allByName, byName, click, has, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// S16, its last door. A guest views the household's to-dos and changes none of
// them: the to-do page offers it no tick-off, and the to-do actions and
// services refuse one. Focus Mode was the way round both — it wrote
// `todo_items.is_done` straight from the browser, and RLS on that table lets
// any family member update it. So a guest opening Focus was handed "Mark done"
// on every open family to-do, and the tick stuck.
//
// The REAL FocusModule, its own reads and its own write, against an in-memory
// database.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
// Focus ticks a to-do off through the To-dos page's own action
// (completeTodoAction), on the server: the session is the same member's and the
// server client reads and writes the same in-memory database.
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
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { FocusModule } = await import('@/components/modules/focus-module');

const FAMILY = h.app.familyId;
const SELF = 'member-self';
let db: ReturnType<typeof createInMemorySupabase>;

function as(role: string) {
  (h.app as Record<string, unknown>).role = role;
  h.app.selfMember = { id: SELF, display_name: 'Gran', role, is_active: true, color: null, birthday: null, family_id: FAMILY };
}

/** Mount, let the queue's own reads land, and render what came back. */
async function show(): Promise<ReactNode> {
  render(h.hooks, createElement(FocusModule));
  for (let pass = 0; pass < 5; pass++) await settle();
  return render(h.hooks, createElement(FocusModule));
}

const todo = () => db.table('todo_items').find((row) => row.id === 'todo-1')!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  db.seed('family_members', [{ id: SELF, family_id: FAMILY, user_id: h.app.userId }]);
  db.seed('todo_items', [{ id: 'todo-1', family_id: FAMILY, title: 'Book the dentist', is_done: false, created_at: '2026-10-01T09:00:00Z' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('S16 — Focus Mode hands a guest no tick-off on the family to-dos', () => {
  it('a guest is not shown the family to-dos, nor offered "Mark done", and nothing is written', async () => {
    as('guest');
    const tree = await show();

    expect(has(tree, 'Book the dentist')).toBe(false);
    expect(allByName(tree, /Mark done/)).toHaveLength(0);
    expect(has(tree, 'Nothing on your plate')).toBe(true);
    expect(todo().is_done).toBe(false);
    expect(h.calls.filter((call) => call.table === 'todo_items')).toHaveLength(0);
  });

  it.each(['parent', 'teen'])('a %s still ticks a to-do off from Focus, and it is saved', async (role) => {
    as(role);
    const tree = await show();

    expect(has(tree, 'Book the dentist')).toBe(true);
    await click(byName(tree, /Mark done/));

    expect(todo().is_done).toBe(true);
    expect(h.toasts.error).toEqual([]);
  });
});
