import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { allByName, byName, change, click, has, nodes, render, settle, submit, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The kids-and-learning modules, driven as a person drives them: the REAL
// component, its own reads (run against an in-memory database capped at
// PostgREST's db-max-rows, 1,000) and its own writes.
//
//   S1   to-dos      one unpaged read, oldest-due first, lost the newest-dated
//                    and every undated OPEN task once done ones passed 1,000
//   S8   homework    the same, for today's and upcoming homework
//   S9   rewards     balances summed over an unordered 1,000 of the ledger
//   S12  projects    materials oldest-first `.limit(1000)`, quotes cheapest
//                    first `.limit(600)`: the new and the dear fell off
//   S3/S4 to-dos     a "Shared with family" box nothing ever applied
//   S16  to-dos      a guest was offered add, edit and tick-off
//   S17  homework    "Due today" was the device's day, not the family's
//   S14/S15          the AI buttons offered a guest what the route refuses
//   S18  language    a double tap logged a sitting twice and graded twice
//
// The realtime hook is replaced by one keyed on (table, deps), so a module that
// reads one table three ways — open, finished, counted — keeps three lists.

type Fetcher = (client: unknown) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const live = vi.hoisted(() => ({
  queries: new Map<string, { fetcher: Fetcher; data: unknown[]; error: string | null; loaded: boolean }>(),
}));
const actions = vi.hoisted(() => ({
  completeTodo: vi.fn(async () => ({ ok: true, id: 'x' })),
  createTodo: vi.fn(async () => ({ ok: true, id: 'x' })),
  updateTodo: vi.fn(async () => ({ ok: true, id: 'x' })),
  deleteTodo: vi.fn(async () => ({ ok: true, id: 'x' })),
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return {
    useRealtimeQuery: ({ table, deps, fetcher }: { table: string; deps?: unknown[]; fetcher: Fetcher }) => {
      const key = `${table}|${JSON.stringify(deps ?? [])}`;
      let query = live.queries.get(key);
      if (!query) { query = { fetcher, data: [], error: null, loaded: false }; live.queries.set(key, query); }
      query.fetcher = fetcher;
      const entry = query;
      const reread = async () => {
        const { data, error } = await entry.fetcher(clientFor(h));
        entry.loaded = true;
        entry.error = error ? error.message : null;
        if (!error) entry.data = data ?? [];
        return !error;
      };
      return {
        data: entry.data, loading: !entry.loaded, error: entry.error, stale: false, updatedAt: 0,
        refresh: async () => { await reread(); },
        refreshAndConfirm: async () => ((await reread()) ? { ok: true as const } : { ok: false as const, reason: 'error' as const }),
        setData: (update: unknown[] | ((rows: unknown[]) => unknown[])) => {
          entry.data = typeof update === 'function' ? update(entry.data) : update;
        },
      };
    },
  };
});
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
// The AI button as a marker, so a test can see whether the page offers it.
vi.mock('@/components/ai/ai-insight', async () => {
  const { createElement: el } = await import('react');
  return { AiInsight: ({ kind }: { kind: string }) => el('span', { 'data-insight': kind }) };
});
vi.mock('@/app/(app)/dashboard/todos/actions', () => ({
  completeTodoAction: actions.completeTodo,
  createTodoAction: actions.createTodo,
  updateTodoAction: actions.updateTodo,
  deleteTodoAction: actions.deleteTodo,
}));
vi.mock('@/app/(app)/dashboard/rewards/actions', () => ({
  requestRedemptionAction: vi.fn(async () => ({ ok: true })),
  decideRedemptionAction: vi.fn(async () => ({ ok: true })),
}));

const { TodosModule } = await import('@/components/modules/todos-module');
const { HomeworkModule } = await import('@/components/modules/homework-module');
const { TimetableModule } = await import('@/components/modules/timetable-module');
const { RewardsModule } = await import('@/components/modules/rewards-module');
const { ProjectsModule } = await import('@/components/modules/projects-module');
const { LanguageModule } = await import('@/components/modules/language-module');
const { dueBucket } = await import('@/lib/homework/board');
const { GRADES } = await import('@/lib/language/practice');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const PARENT = 'member-1';
const KID = 'member-2';
const OTHER_KID = 'member-3';
let db: ReturnType<typeof createInMemorySupabase>;

function as(role: string) {
  (h.app as Record<string, unknown>).role = role;
  h.app.selfMember = { ...h.app.members.find((m) => m.role === role) ?? { id: PARENT, display_name: 'Ada', role, is_active: true, color: null, birthday: null }, family_id: FAMILY };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  resetHookSlots(h.hooks);
  live.queries.clear();
  // PostgREST's db-max-rows on a default Supabase project.
  db = createInMemorySupabase({ maxRows: 1000, defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  h.app.members = [
    { id: PARENT, display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: KID, display_name: 'Bo', role: 'child', is_active: true, color: null, birthday: null },
    { id: OTHER_KID, display_name: 'Cy', role: 'teen', is_active: true, color: null, birthday: null },
    { id: 'member-4', display_name: 'Gran', role: 'guest', is_active: true, color: null, birthday: null },
  ];
  as('parent');
  for (const action of Object.values(actions)) action.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Render, run every read the screen registered against the capped database, and render what came back. */
async function show(element: () => ReturnType<typeof createElement>): Promise<ReactNode> {
  for (let pass = 0; pass < 6; pass++) {
    render(h.hooks, element());
    const pending = [...live.queries.values()].filter((q) => !q.loaded);
    if (!pending.length) break;
    for (const query of pending) {
      const { data, error } = await query.fetcher((await import('./helpers/module-harness')).clientFor(h));
      query.loaded = true;
      query.error = error ? error.message : null;
      query.data = error ? [] : data ?? [];
    }
  }
  return render(h.hooks, element());
}
const insightOffered = (tree: ReactNode, kind: string) => nodes(tree).some((n) => n.props['data-insight'] === kind);
/** An hour apart from 1 January 2025, so a thousand of them stay in early 2025 and in order. */
const hour = (n: number) => new Date(Date.parse('2025-01-01T00:00:00Z') + n * 3_600_000).toISOString();
const day = (n: number) => hour(n).slice(0, 10);

describe('S1 — the to-do list reads every open task, however many are done', () => {
  beforeEach(() => {
    db.seed('todo_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Tasks', icon: '📋', color: 'violet', is_shared: true, sort_order: 0, archived_at: null }]);
    // A thousand finished tasks, all due before anything still open.
    db.seed('todo_items', Array.from({ length: 1000 }, (_, i) => ({
      id: `done-${String(i).padStart(4, '0')}`, family_id: FAMILY, list_id: 'list-1', title: `Old task ${i}`, is_done: true,
      priority: 'medium', due_date: day(i), completed_at: hour(i), created_by: PARENT, assigned_to_id: null, tags: [],
    })));
    db.seed('todo_items', [
      { id: 'open-1', family_id: FAMILY, list_id: 'list-1', title: 'Book the dentist', is_done: false, priority: 'high', due_date: '2026-10-20', completed_at: null, created_by: PARENT, assigned_to_id: PARENT, tags: [] },
      { id: 'open-2', family_id: FAMILY, list_id: 'list-1', title: 'Renew the passports', is_done: false, priority: 'medium', due_date: null, completed_at: null, created_by: PARENT, assigned_to_id: null, tags: [] },
      { id: 'open-3', family_id: FAMILY, list_id: 'list-1', title: 'Call the plumber', is_done: false, priority: 'urgent', due_date: '2026-10-13', completed_at: null, created_by: PARENT, assigned_to_id: null, tags: [] },
    ]);
  });

  it('shows the undated and newest open tasks, and counts open and finished exactly', async () => {
    const tree = await show(() => createElement(TodosModule));

    expect(has(tree, 'Renew the passports')).toBe(true);
    expect(has(tree, 'Book the dentist')).toBe(true);
    expect(has(tree, 'Call the plumber')).toBe(true);
    expect(text(byName(tree, new RegExp(`^${t('todosModule.tab.allTasks')}\\d+$`)))).toBe(`${t('todosModule.tab.allTasks')}3`);
    expect(text(byName(tree, new RegExp(`^${t('todosModule.tab.completed')}\\d+$`)))).toBe(`${t('todosModule.tab.completed')}1000`);
  });

  it('the Completed tab lists the newest finished tasks and says how many there are in all', async () => {
    const tree = await show(() => createElement(TodosModule));
    await click(byName(tree, new RegExp(`^${t('todosModule.tab.completed')}\\d+$`)));
    const completed = await show(() => createElement(TodosModule));

    expect(has(completed, t('todosModule.showingRecentCompleted', { shown: 200, total: 1000 }))).toBe(true);
    // Newest first: the last of the thousand is listed, the first is not.
    const listed = (title: string) => nodes(completed).some((n) => n.type === 'p' && text(n) === title);
    expect(listed('Old task 999')).toBe(true);
    expect(listed('Old task 0')).toBe(false);
  });
});

describe('AUD-1040-COMPLETED-SEARCH — a search of the Completed tab reaches every finished task', () => {
  // 260 finished: the list shows the newest 200, and the oldest one has a title
  // nothing else shares. Searching the listed 200 alone answered "No completed
  // tasks" for it, with the exact count of 260 on the tab above.
  // Patterns read as the transport reads them: PostgREST's `*` alias, then
  // LIKE with backslash escapes (InMemoryOptions.likeSyntax).
  const STARRED = 'Math* worksheet';
  const PERCENT = 'Math% worksheet';
  beforeEach(() => {
    db = createInMemorySupabase({ maxRows: 1000, defaults: HOUSEHOLD_DEFAULTS, likeSyntax: 'postgrest' });
    h.db = db;
    db.seed('todo_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Tasks', icon: '📋', color: 'violet', is_shared: true, sort_order: 0, archived_at: null }]);
    db.seed('todo_items', Array.from({ length: 260 }, (_, i) => ({
      id: `done-${String(i).padStart(4, '0')}`, family_id: FAMILY, list_id: 'list-1',
      title: i === 0 ? 'Return the library books' : i === 1 ? STARRED : i === 2 ? PERCENT : `Old task ${i}`,
      is_done: true, priority: 'medium', due_date: day(i), completed_at: hour(i), created_by: PARENT, assigned_to_id: null, tags: [],
    })));
  });
  async function completedTab(): Promise<ReactNode> {
    const tree = await show(() => createElement(TodosModule));
    await click(byName(tree, new RegExp(`^${t('todosModule.tab.completed')}\\d+$`)));
    return show(() => createElement(TodosModule));
  }
  async function search(tree: ReactNode, value: string): Promise<ReactNode> {
    change(nodes(tree).find((n) => n.type === 'input' && n.props.placeholder === t('todos.searchTasks'))!, value);
    return show(() => createElement(TodosModule));
  }
  /** Typing rests before the database is asked (SEARCH_SETTLE_MS). */
  const typingRests = () => new Promise((resolve) => setTimeout(resolve, 300));
  const listed = (tree: ReactNode, title: string) => nodes(tree).some((n) => n.type === 'p' && text(n) === title);

  it('finds the oldest finished task by its title, and keeps the exact count', async () => {
    let tree = await completedTab();
    expect(listed(tree, 'Return the library books')).toBe(false);

    tree = await search(tree, 'library books');
    // Asked, not yet answered: that is not "no match".
    expect(has(tree, t('todosModule.searchingCompleted'))).toBe(true);
    expect(has(tree, 'No completed tasks')).toBe(false);

    await typingRests();
    tree = await show(() => createElement(TodosModule));
    expect(listed(tree, 'Return the library books')).toBe(true);
    expect(has(tree, 'No completed tasks')).toBe(false);
    expect(text(byName(tree, new RegExp(`^${t('todosModule.tab.completed')}\\d+$`)))).toBe(`${t('todosModule.tab.completed')}260`);
  });

  it.each([
    ['math*', STARRED, PERCENT],
    ['math%', PERCENT, STARRED],
  ])('searching every finished task for %s finds that title literally', async (term, found, notFound) => {
    let tree = await search(await completedTab(), term);
    await typingRests();
    tree = await show(() => createElement(TodosModule));
    expect(listed(tree, found)).toBe(true);
    expect(listed(tree, notFound)).toBe(false);
  });

  it.each([
    ['math*', STARRED, PERCENT],
    ['math%', PERCENT, STARRED],
  ])('with every finished task listed, %s matches the same title', async (term, found, notFound) => {
    db.table('todo_items').splice(3, 60);
    const tree = await search(await completedTab(), term);
    expect(listed(tree, found)).toBe(true);
    expect(listed(tree, notFound)).toBe(false);
  });

  it('a search no finished task matches says so', async () => {
    let tree = await search(await completedTab(), 'zebra crossing');
    await typingRests();
    tree = await show(() => createElement(TodosModule));
    expect(has(tree, 'No completed tasks')).toBe(true);
  });

  it('more matches than are listed says the list is the newest of them', async () => {
    let tree = await search(await completedTab(), 'Old task');
    await typingRests();
    tree = await show(() => createElement(TodosModule));
    expect(listed(tree, 'Old task 259')).toBe(true);
    expect(listed(tree, 'Old task 59')).toBe(false);
    expect(has(tree, t('todosModule.showingNewestMatches', { shown: 200 }))).toBe(true);
  });

  it('with every finished task listed, a search stays on the list and asks nothing more', async () => {
    db.table('todo_items').splice(0, 60);
    let tree = await completedTab();
    const asked = h.calls.length;
    tree = await search(tree, 'Old task 25');
    expect(has(tree, t('todosModule.searchingCompleted'))).toBe(false);
    expect(listed(tree, 'Old task 250')).toBe(true);
    await typingRests();
    await show(() => createElement(TodosModule));
    expect(h.calls.slice(asked).some((c) => c.table === 'todo_items' && c.calls.includes('ilike'))).toBe(false);
  });
});

describe('S3/S4 — a to-do category is the family\'s, and says so', () => {
  it('offers no "Shared with family" box nothing applies, and records who made the category', async () => {
    db.seed('todo_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Tasks', icon: '📋', color: 'violet', is_shared: true, sort_order: 0, archived_at: null }]);
    let tree = await show(() => createElement(TodosModule));
    await click(byName(tree, t('todos.addTask')));
    tree = await show(() => createElement(TodosModule));
    await click(byName(tree, 'New'));
    tree = await show(() => createElement(TodosModule));

    const newCategory = nodes(tree).filter((n) => n.type === 'form')
      .find((f) => nodes(f.props.children as ReactNode).some((n) => n.props.placeholder === t('todos.schoolShoppingChores')));
    expect(newCategory, 'the New Category form is open').toBeDefined();
    const fields = nodes(newCategory!.props.children as ReactNode);
    expect(fields.some((n) => n.type === 'input' && n.props.type === 'checkbox')).toBe(false);
    expect(has(newCategory!, t('todos.sharedWithFamily'))).toBe(false);
    expect(has(newCategory!, t('todosModule.listsAreFamilyWide'))).toBe(true);

    change(fields.find((n) => n.props.placeholder === t('todos.schoolShoppingChores'))!, 'Gift ideas');
    const reopened = nodes(render(h.hooks, createElement(TodosModule))).filter((n) => n.type === 'form')
      .find((f) => nodes(f.props.children as ReactNode).some((n) => n.props.placeholder === t('todos.schoolShoppingChores')))!;
    await submit(reopened);

    expect(db.table('todo_lists').find((l) => l.name === 'Gift ideas')).toMatchObject({ is_shared: true, created_by: PARENT });
  });
});

describe('S16 — a guest views the to-dos and is offered nothing that changes them', () => {
  beforeEach(() => {
    db.seed('todo_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Tasks', icon: '📋', color: 'violet', is_shared: true, sort_order: 0, archived_at: null }]);
    db.seed('todo_items', [{ id: 'open-1', family_id: FAMILY, list_id: 'list-1', title: 'Book the dentist', is_done: false, priority: 'high', due_date: '2026-10-20', completed_at: null, created_by: PARENT, assigned_to_id: null, tags: [] }]);
  });

  it('a guest sees the task but no add, edit or tick-off control', async () => {
    as('guest');
    const tree = await show(() => createElement(TodosModule));

    expect(has(tree, 'Book the dentist')).toBe(true);
    expect(allByName(tree, t('todos.addTask'))).toEqual([]);
    expect(allByName(tree, t('uiText.markDone'))).toEqual([]);
    expect(allByName(tree, t('todos.editTask'))).toEqual([]);
    expect(has(tree, t('todos.quickAdd'))).toBe(false);
  });

  it('a parent keeps every control', async () => {
    const tree = await show(() => createElement(TodosModule));
    expect(allByName(tree, t('todos.addTask')).length).toBeGreaterThan(0);
    expect(allByName(tree, t('uiText.markDone'))).toHaveLength(1);
    expect(allByName(tree, t('todos.editTask'))).toHaveLength(1);
  });
});

describe('S8 — the homework board reads every open assignment, however much is finished', () => {
  beforeEach(() => {
    db.seed('homework_assignments', Array.from({ length: 1000 }, (_, i) => ({
      id: `hw-done-${String(i).padStart(4, '0')}`, family_id: FAMILY, member_id: KID, title: `Old worksheet ${i}`, subject: 'Math',
      status: 'done', due_at: `${day(i)}T15:00:00Z`, completed_at: `${day(i)}T16:00:00Z`, details: null, created_by: 'user-1',
    })));
    db.seed('homework_assignments', [
      { id: 'hw-open-1', family_id: FAMILY, member_id: OTHER_KID, title: 'Essay on rivers', subject: 'Geography', status: 'assigned', due_at: '2026-10-16T15:00:00Z', completed_at: null, details: null, created_by: 'user-1' },
      { id: 'hw-open-2', family_id: FAMILY, member_id: OTHER_KID, title: 'Read chapter 4', subject: 'English', status: 'in_progress', due_at: null, completed_at: null, details: null, created_by: 'user-1' },
    ]);
  });

  it('today\'s, upcoming and undated homework is on the board, and the tiles count all of it', async () => {
    const tree = await show(() => createElement(HomeworkModule));

    expect(has(tree, 'Essay on rivers')).toBe(true);
    expect(has(tree, 'Read chapter 4')).toBe(true);
    // Open 2; 1,000 of 1,002 finished.
    const tiles = nodes(tree).filter((n) => n.type === 'div' && typeof n.props.className === 'string' && n.props.className.includes('text-2xl font-bold'));
    expect(tiles.map((n) => text(n))).toEqual(['2', '0', '100%']);
  });

  it('a student whose work is all still to do is not told "No homework yet"', async () => {
    const tree = await show(() => createElement(HomeworkModule));
    await click(byName(tree, 'Cy'));
    const filtered = await show(() => createElement(HomeworkModule));
    expect(has(filtered, t('homework.noHomeworkYet'))).toBe(false);
    expect(has(filtered, 'Essay on rivers')).toBe(true);
  });
});

describe('S17 — "Due today" is the family\'s day, not the device\'s', () => {
  // Kiritimati is UTC+14: at 12:00 UTC on 13 October it is already 02:00 on the
  // 14th there, and 08:00 UTC on the 14th is 22:00 that same family day. On a
  // device in UTC, Los Angeles or Tokyo those are two different days.
  const NOW = new Date('2026-10-13T12:00:00Z');
  const DUE = '2026-10-14T08:00:00Z';

  it('the board files tonight\'s deadline under Due today', async () => {
    h.timeZone = 'Pacific/Kiritimati';
    db.seed('homework_assignments', [{ id: 'hw-1', family_id: FAMILY, member_id: KID, title: 'Spelling list', subject: null, status: 'assigned', due_at: DUE, completed_at: null, details: null, created_by: 'user-1' }]);
    const tree = await show(() => createElement(HomeworkModule));

    const headings = nodes(tree).filter((n) => n.type === 'h2').map((n) => text(n));
    expect(headings).toContain('Due today (1)');
    expect(headings.some((heading) => heading.startsWith('Upcoming'))).toBe(false);
  });

  it('dueBucket answers in the zone it is given', () => {
    expect(dueBucket({ id: 'a', due_at: DUE, status: 'assigned' }, NOW, 'Pacific/Kiritimati')).toBe('today');
    expect(dueBucket({ id: 'a', due_at: '2026-10-14T11:00:00Z', status: 'assigned' }, NOW, 'Pacific/Kiritimati')).toBe('upcoming');
  });
});

describe('S14/S15 — the AI buttons are offered to the roles the route answers', () => {
  it.each([
    ['homework', HomeworkModule],
    ['timetable', TimetableModule],
  ] as const)('a guest is not offered the %s summary; a child and a parent are', async (kind, Module) => {
    as('guest');
    expect(insightOffered(await show(() => createElement(Module)), kind)).toBe(false);
    for (const role of ['child', 'parent']) {
      resetHookSlots(h.hooks); live.queries.clear(); as(role);
      expect(insightOffered(await show(() => createElement(Module)), kind), role).toBe(true);
    }
  });
});

describe('S9 — reward balances are the whole ledger\'s', () => {
  it('a family past a thousand approved chores sees every point, and the parent can approve what the ledger covers', async () => {
    db.seed('chore_assignments', [
      ...Array.from({ length: 600 }, (_, i) => ({ id: `a-${String(i).padStart(4, '0')}`, family_id: FAMILY, member_id: KID, chore_id: 'c1', status: 'approved', points_awarded: 1 })),
      ...Array.from({ length: 600 }, (_, i) => ({ id: `b-${String(i).padStart(4, '0')}`, family_id: FAMILY, member_id: OTHER_KID, chore_id: 'c1', status: 'approved', points_awarded: 1 })),
    ]);
    db.seed('rewards', [{ id: 'reward-1', family_id: FAMILY, title: 'Cinema trip', description: null, cost_points: 500, redeemed_by: null }]);
    db.seed('reward_redemptions', [{ id: 'red-1', family_id: FAMILY, member_id: OTHER_KID, reward_id: 'reward-1', reward_title: 'Cinema trip', cost_points: 500, status: 'requested', created_at: '2026-10-12T10:00:00Z' }]);
    const tree = await show(() => createElement(RewardsModule));

    // 0439 sums Cy's full ledger: 600 earned, 500 is affordable.
    const leaderboard = nodes(tree).filter((n) => n.type === 'div' && typeof n.props.className === 'string' && n.props.className.includes('text-2xl font-bold text-amber-400')).map((n) => text(n));
    expect(leaderboard).toEqual(['600', '600', '0', '0']);
    expect(byName(tree, t('rewards.approve')).props.disabled).toBe(false);
  });
});

describe('AUD-1040-LEDGER-PAGING — a request landing between ledger pages spends nothing twice', () => {
  it('an approved redemption is subtracted once when a new request lands between two pages', async () => {
    db.seed('chore_assignments', Array.from({ length: 600 }, (_, i) => ({
      id: `b-${String(i).padStart(4, '0')}`, family_id: FAMILY, member_id: OTHER_KID, chore_id: 'c1', status: 'approved', points_awarded: 1,
    })));
    db.seed('rewards', [{ id: 'reward-1', family_id: FAMILY, title: 'Cinema trip', description: null, cost_points: 100, redeemed_by: null }]);
    const redemption = (id: string, patch: Record<string, unknown>) => ({
      id, family_id: FAMILY, member_id: KID, reward_id: 'reward-1', reward_title: 'Cinema trip', cost_points: 1, status: 'rejected', ...patch,
    });
    // A thousand-and-one rows, so the ledger takes two pages; the one approved
    // redemption sits at the end of the first, in either reading order.
    db.seed('reward_redemptions', [
      ...Array.from({ length: 999 }, (_, i) => redemption(`r-${String(i).padStart(4, '0')}`, { created_at: '2026-10-12T10:00:00Z' })),
      redemption('red-approved', { member_id: OTHER_KID, cost_points: 100, status: 'approved', created_at: '2026-10-01T10:00:00Z' }),
      redemption('r-old', { created_at: '2026-09-01T10:00:00Z' }),
    ]);
    // Held between page one and page two: a child asks for a reward.
    let pages = 0;
    h.fault = (table, calls) => {
      if (table === 'reward_redemptions' && calls.includes('select') && ++pages === 2) {
        db.seed('reward_redemptions', [redemption('req-new', { cost_points: 500, status: 'requested', created_at: '2026-10-13T11:00:00Z' })]);
      }
      return null;
    };
    const tree = await show(() => createElement(RewardsModule));

    // Cy: 600 earned, 100 spent once. The new request spends nothing.
    const leaderboard = nodes(tree).filter((n) => n.type === 'div' && typeof n.props.className === 'string' && n.props.className.includes('text-2xl font-bold text-amber-400')).map((n) => text(n));
    expect(leaderboard).toEqual(['500', '0', '0', '0']);
  });
});

describe('AUD-1040-LEDGER-PAGING — a ledger refused on a later page is not a balance', () => {
  it.each(['chore_assignments', 'reward_redemptions'])('%s refused past its first page shows no leaderboard and offers nothing to approve', async (table) => {
    db.seed('chore_assignments', [{ id: 'b-0001', family_id: FAMILY, member_id: OTHER_KID, chore_id: 'c1', status: 'approved', points_awarded: 600 }]);
    db.seed('rewards', [{ id: 'reward-1', family_id: FAMILY, title: 'Cinema trip', description: null, cost_points: 100, redeemed_by: null }]);
    db.seed('reward_redemptions', [{ id: 'red-1', family_id: FAMILY, member_id: OTHER_KID, reward_id: 'reward-1', reward_title: 'Cinema trip', cost_points: 100, status: 'requested', created_at: '2026-10-12T10:00:00Z' }]);
    // The first page arrives; the next (`id > last`) is refused.
    h.fault = (faulted, calls) => (faulted === table && calls.includes('gt') ? { message: 'permission denied', code: '42501' } : null);
    const tree = await show(() => createElement(RewardsModule));

    const leaderboard = nodes(tree).filter((n) => n.type === 'div' && typeof n.props.className === 'string' && n.props.className.includes('text-2xl font-bold text-amber-400'));
    expect(leaderboard).toEqual([]);
    expect(allByName(tree, t('rewards.approve'))).toEqual([]);
  });
});

describe('S12 — a project\'s new materials and dear quotes are loaded', () => {
  it('the active project counts the material just added and the quote it accepted', async () => {
    db.seed('home_projects', [
      { id: 'proj-old', family_id: FAMILY, title: 'Old deck', status: 'done', updated_at: '2025-06-01T00:00:00Z' },
      { id: 'proj-new', family_id: FAMILY, title: 'New fence', status: 'planning', is_diy: false, updated_at: '2026-10-12T00:00:00Z' },
    ]);
    db.seed('project_materials', [
      ...Array.from({ length: 1000 }, (_, i) => ({ id: `mat-${String(i).padStart(4, '0')}`, family_id: FAMILY, project_id: 'proj-old', name: `Board ${i}`, created_at: `${day(i)}T09:00:00Z` })),
      { id: 'mat-new', family_id: FAMILY, project_id: 'proj-new', name: 'Fence panels', est_cost_cents: 12000, created_at: '2026-10-12T09:00:00Z' },
    ]);
    db.seed('project_quotes', [
      ...Array.from({ length: 600 }, (_, i) => ({ id: `q-${String(i).padStart(4, '0')}`, family_id: FAMILY, project_id: 'proj-old', amount_cents: 100 + i, status: 'declined' })),
      { id: 'q-accepted', family_id: FAMILY, project_id: 'proj-new', amount_cents: 450000, status: 'accepted' },
    ]);
    const tree = await show(() => createElement(ProjectsModule));

    const card = nodes(tree).find((n) => n.type === 'button' && text(n).includes('New fence'))!;
    expect(text(card)).toContain('0/1 materials');
    expect(text(card)).toContain('1 quote');
  });
});

describe('S18 — a review sitting is logged once and a grade counts once', () => {
  beforeEach(() => {
    db.seed('language_goals', [{ id: 'goal-1', family_id: FAMILY, member_id: PARENT, language_code: 'es', language_label: 'Spanish' }]);
    db.seed('vocab_cards', [
      { id: 'card-1', family_id: FAMILY, goal_id: 'goal-1', term: 'perro', translation: 'dog', due_on: '2026-10-13' },
      { id: 'card-2', family_id: FAMILY, goal_id: 'goal-1', term: 'gato', translation: 'cat', due_on: '2026-10-13' },
    ]);
  });

  async function revealed(): Promise<ReactNode> {
    const tree = await show(() => createElement(LanguageModule));
    await click(byName(tree, t('language.showAnswer')));
    return render(h.hooks, createElement(LanguageModule));
  }
  const gradeButton = (tree: ReactNode, label: string) =>
    nodes(tree).find((n) => n.type === 'button' && text(n).startsWith(label)) as Node;
  const tap = (node: Node) => (node.props.onClick as () => unknown)();

  it('two taps on a grade count one review', async () => {
    const good = gradeButton(await revealed(), GRADES[2].label);
    await Promise.all([tap(good), tap(good)]);
    await settle();
    const after = render(h.hooks, createElement(LanguageModule));

    expect(has(after, `1 ${t('language.reviewedThisSitting')}`)).toBe(true);
  });

  it('two taps on "log it as practice" write one session', async () => {
    await click(gradeButton(await revealed(), GRADES[2].label));
    const log = byName(render(h.hooks, createElement(LanguageModule)), t('language.logItAsPractice'));
    await Promise.all([tap(log), tap(log)]);
    await settle();

    expect(db.table('language_sessions')).toHaveLength(1);
    expect(db.table('language_sessions')[0]).toMatchObject({ kind: 'vocab', topic: '1 cards reviewed' });
  });

  it('a log that does not land hands the sitting back', async () => {
    await click(gradeButton(await revealed(), GRADES[2].label));
    h.fault = (table, calls) => (table === 'language_sessions' && calls.includes('insert') ? { message: 'refused' } : null);
    await click(byName(render(h.hooks, createElement(LanguageModule)), t('language.logItAsPractice')));

    expect(db.table('language_sessions')).toHaveLength(0);
    expect(has(render(h.hooks, createElement(LanguageModule)), `1 ${t('language.reviewedThisSitting')}`)).toBe(true);
  });
});
