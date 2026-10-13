import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, has, nodes, render, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Removing a REPEATING chore that several children share, from one child's
// row on the board: the REAL ChoresModule, the REAL delete action behind its
// menu, and the REAL push-scan sweep afterwards, against one in-memory
// database that keeps 0256's partial unique index on the respawn key.
//
// A chore shared by several children is the ordinary case, not the assistant's
// alone: /missions/new shows one "Assign to" checkbox per kid, and
// createChoreAction writes ONE chore with one assignment per ticked child. A
// delete retires only a chore no other child has (lib/services/tasks
// `deleteOutcome`), so for a shared chore the sweep
// (`respawnMissingChoreAssignments`) finds this child's finished assignment
// with nothing open after it and puts the chore back. The board still said
// "Chore removed". Stopping it for one child needs a tombstone the sweep reads
// (owner SQL); until then the board says what will happen.

type Fetcher = (client: unknown) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const live = vi.hoisted(() => ({
  queries: new Map<string, { fetcher: Fetcher; data: unknown[]; error: string | null; loaded: boolean }>(),
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
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
// The two money/reward actions the board imports are not what these cases are about.
vi.mock('@/app/(app)/wallet/actions', () => ({ payChoreRewardAction: vi.fn(async () => ({ ok: false, error: 'not here' })) }));
vi.mock('@/app/(app)/dashboard/rewards/actions', () => ({ requestRedemptionAction: vi.fn(async () => ({ ok: false, error: 'not here' })) }));
// The chores actions are REAL; their session and database are these.
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: null },
    memberships: [],
    active: {
      familyId: h.app.familyId, role: 'parent',
      member: { id: 'member-1', family_id: h.app.familyId },
      family: { id: h.app.familyId, name: 'Fixture family', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const messages = await import('@/lib/i18n/messages');
  const tr = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr.translate(messages.SOURCE_MESSAGES, key, params) };
});

const { ChoresModule } = await import('@/components/modules/chores-module');
const { deleteChoreAssignmentAction } = await import('@/app/(app)/dashboard/chores/actions');
const { respawnMissingChoreAssignments, respawnKeyFor } = await import('@/lib/services/tasks');

type DB = SupabaseClient<Database>;
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const PARENT = 'member-1';
const KID = 'member-2';
const SIB = 'member-3';
const NOW = '2026-10-13T12:00:00.000Z';
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  resetHookSlots(h.hooks);
  live.queries.clear();
  db = createInMemorySupabase({
    maxRows: 1000,
    defaults: {
      chores: { description: null, points: 10, priority: 'medium', recurrence: 'none', due_at: null, requires_approval: true, icon: null, is_active: true, cash_cents: null },
      chore_assignments: { status: 'todo', due_at: null, submitted_at: null, approved_at: null, approved_by: null, points_awarded: null, ai_score: null, cash_awarded_cents: null, idempotency_key: null, disputed: false },
    },
    // 0256's PARTIAL unique index: unkeyed rows repeat freely, keyed ones do not.
    uniques: { chore_assignments: [['family_id', 'idempotency_key']] },
  });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  h.app.members = [
    { id: PARENT, display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: KID, display_name: 'Bo', role: 'child', is_active: true, color: null, birthday: null },
    { id: SIB, display_name: 'Cy', role: 'child', is_active: true, color: null, birthday: null },
  ];
  h.app.selfMember = h.app.members[0];
  (h.app as Record<string, unknown>).role = 'parent';
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, display_name: 'Ada', role: 'parent', is_active: true },
    { id: KID, family_id: FAMILY, display_name: 'Bo', role: 'child', is_active: true },
    { id: SIB, family_id: FAMILY, display_name: 'Cy', role: 'child', is_active: true },
  ]);
  // The open row menu listens for Escape (useDismissOnEscape, and the board's
  // own effect), and Delete asks the browser to confirm: a parent says yes.
  const listeners = { addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal('document', { ...listeners, visibilityState: 'visible' });
  vi.stubGlobal('window', { ...listeners, confirm: () => true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Render, run every read the board registered, and render what came back. */
async function show(): Promise<ReactNode> {
  const { clientFor } = await import('./helpers/module-harness');
  for (let pass = 0; pass < 6; pass++) {
    render(h.hooks, createElement(ChoresModule));
    const pending = [...live.queries.values()].filter((q) => !q.loaded);
    if (!pending.length) break;
    for (const query of pending) {
      const { data, error } = await query.fetcher(clientFor(h));
      query.loaded = true;
      query.error = error ? error.message : null;
      query.data = error ? [] : data ?? [];
    }
  }
  return render(h.hooks, createElement(ChoresModule));
}

/** The one chore row on screen that names this child: the innermost element holding both their name and one row menu. */
function rowOf(tree: ReactNode, name: string): Node {
  const rows = nodes(tree).filter((node) => allByName(node, t('chores.choreActions')).length === 1 && has(node, name));
  if (!rows.length) throw new Error(`no chore row for ${name}`);
  return rows[rows.length - 1];
}

/** A parent on All Chores opens this child's row menu and picks Delete. */
async function deleteFromBoardFor(name: string): Promise<void> {
  await click(byName(await show(), t('choresModule.tab.all')));
  await click(byName(rowOf(await show(), name), t('chores.choreActions')));
  await click(byName(rowOf(await show(), name), t('chores.delete')));
}

const sweep = () => respawnMissingChoreAssignments({
  db: db as unknown as DB, familyId: FAMILY, userId: 'system', memberId: null, role: 'system', actorKind: 'system', tz: 'UTC', now: new Date(NOW),
} as ServiceScope);
const openOf = (member: string) => db.table('chore_assignments')
  .filter((row) => row.member_id === member && row.chore_id === 'chore-bed' && ['todo', 'in_progress'].includes(row.status as string));

/** Yesterday's, approved; today's, created by that approval under its respawn key. */
const finishedAndNext = (member: string, suffix: string, createdAt: string) => [
  { id: `asg-${suffix}-done`, family_id: FAMILY, chore_id: 'chore-bed', member_id: member, status: 'approved', due_at: '2026-10-12T18:00:00.000Z', approved_at: '2026-10-12T19:00:00.000Z', points_awarded: 10, created_at: '2026-10-12T06:00:00.000Z' },
  { id: `asg-${suffix}-next`, family_id: FAMILY, chore_id: 'chore-bed', member_id: member, status: 'todo', due_at: '2026-10-13T18:00:00.000Z', idempotency_key: respawnKeyFor(FAMILY, `asg-${suffix}-done`), created_at: createdAt },
];

describe('a repeating chore shared by several children, removed from one child', () => {
  beforeEach(() => {
    // One chore, one assignment per ticked child — what /missions/new writes.
    db.seed('chores', [{ id: 'chore-bed', family_id: FAMILY, title: 'Make your bed', recurrence: 'daily', is_active: true }]);
  });

  it('the board says it will come back, and the sweep does put it back', async () => {
    db.seed('chore_assignments', [
      ...finishedAndNext(KID, 'kid', '2026-10-12T19:00:01.000Z'),
      ...finishedAndNext(SIB, 'sib', '2026-10-12T19:00:02.000Z'),
    ]);

    await deleteFromBoardFor('Bo');

    expect(h.toasts.error).toEqual([]);
    expect(db.table('chore_assignments').some((row) => row.id === 'asg-kid-next')).toBe(false);
    expect(h.toasts.success).toEqual([t('choresModule.choreRemovedComesBack')]);
    expect(h.toasts.success).not.toContain(t('choresModule.choreRemoved'));

    // What the board said is what happens: the sweep puts Bo's back, and Cy keeps theirs.
    const swept = await sweep();
    expect(swept.ok && swept.data.respawned).toBe(1);
    expect(openOf(KID)).toHaveLength(1);
    expect(openOf(SIB)).toHaveLength(1);
    expect(db.table('chores')[0]).toMatchObject({ is_active: true });
  });

  it('says "Chore removed" when this child never finished it, because nothing puts it back', async () => {
    db.seed('chore_assignments', [
      { id: 'asg-kid-first', family_id: FAMILY, chore_id: 'chore-bed', member_id: KID, status: 'todo', due_at: '2026-10-13T18:00:00.000Z', created_at: '2026-10-13T06:00:01.000Z' },
      ...finishedAndNext(SIB, 'sib', '2026-10-12T19:00:02.000Z'),
    ]);

    await deleteFromBoardFor('Bo');

    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual([t('choresModule.choreRemoved')]);
    await sweep();
    expect(openOf(KID)).toEqual([]);
    expect(openOf(SIB)).toHaveLength(1);
  });

  it('says "Chore removed" when the child is no longer in the family, whom the sweep skips', async () => {
    db.seed('chore_assignments', [
      ...finishedAndNext(KID, 'kid', '2026-10-12T19:00:01.000Z'),
      ...finishedAndNext(SIB, 'sib', '2026-10-12T19:00:02.000Z'),
    ]);
    db.table('family_members').find((row) => row.id === KID)!.is_active = false;

    await deleteFromBoardFor('Bo');

    expect(h.toasts.success).toEqual([t('choresModule.choreRemoved')]);
    await sweep();
    expect(openOf(KID)).toEqual([]);
  });
});

describe('a repeating chore that is only this child\'s', () => {
  it('says "Chore removed", and the sweep leaves it removed', async () => {
    db.seed('chores', [{ id: 'chore-bed', family_id: FAMILY, title: 'Make your bed', recurrence: 'daily', is_active: true }]);
    db.seed('chore_assignments', finishedAndNext(KID, 'kid', '2026-10-12T19:00:01.000Z'));

    await deleteFromBoardFor('Bo');

    expect(h.toasts.success).toEqual([t('choresModule.choreRemoved')]);
    await sweep();
    expect(openOf(KID)).toEqual([]);
    expect(db.table('chores')[0]).toMatchObject({ is_active: false });
  });
});

describe('the delete action reports it', () => {
  it('comesBack is true only for the shared chore the sweep will put back', async () => {
    db.seed('chores', [{ id: 'chore-bed', family_id: FAMILY, title: 'Make your bed', recurrence: 'daily', is_active: true }]);
    db.seed('chore_assignments', [
      ...finishedAndNext(KID, 'kid', '2026-10-12T19:00:01.000Z'),
      ...finishedAndNext(SIB, 'sib', '2026-10-12T19:00:02.000Z'),
    ]);

    expect(await deleteChoreAssignmentAction('asg-kid-next')).toEqual({ ok: true, id: 'asg-kid-next', comesBack: true });
    // Cy's finished row: Cy keeps an open one, so nothing comes back for that delete.
    expect(await deleteChoreAssignmentAction('asg-sib-done')).toEqual({ ok: true, id: 'asg-sib-done', comesBack: false });
  });
});

// A submitted or rejected row keeps a chore on the child's board, but the
// sweep counts only to-do and in-progress rows as open: deleting the keyed
// to-do beside one frees the key the sweep repeats under, and the chore comes
// back. Two rows of one chore for one child at once is what the assistant's
// `tasks.assignChore` (which allows duplicates) and new proof on an approved
// row produce.
describe('a submitted or rejected row of the same chore does not stop the sweep', () => {
  /** Bo's approved one, its keyed to-do successor, and an unkeyed extra row in `status`. */
  const withExtra = (status: 'submitted' | 'rejected') => [
    ...finishedAndNext(KID, 'kid', '2026-10-12T19:00:01.000Z'),
    { id: 'asg-kid-extra', family_id: FAMILY, chore_id: 'chore-bed', member_id: KID, status, due_at: '2026-10-13T18:00:00.000Z', created_at: '2026-10-12T20:00:00.000Z' },
  ];

  beforeEach(() => {
    db.seed('chores', [{ id: 'chore-bed', family_id: FAMILY, title: 'Make your bed', recurrence: 'daily', is_active: true }]);
  });

  it.each(['submitted', 'rejected'] as const)('shared, beside a %s row: comesBack, and the sweep does put it back', async (status) => {
    db.seed('chore_assignments', [...withExtra(status), ...finishedAndNext(SIB, 'sib', '2026-10-12T19:00:02.000Z')]);

    expect(await deleteChoreAssignmentAction('asg-kid-next')).toEqual({ ok: true, id: 'asg-kid-next', comesBack: true });

    const swept = await sweep();
    expect(swept.ok && swept.data.respawned).toBe(1);
    expect(openOf(KID)).toHaveLength(1);
  });

  it.each(['submitted', 'rejected'] as const)('only Bo\'s, beside a %s row: comesBack, the chore stays active, and the sweep puts it back', async (status) => {
    db.seed('chore_assignments', withExtra(status));

    expect(await deleteChoreAssignmentAction('asg-kid-next')).toEqual({ ok: true, id: 'asg-kid-next', comesBack: true });
    expect(db.table('chores')[0]).toMatchObject({ is_active: true });

    const swept = await sweep();
    expect(swept.ok && swept.data.respawned).toBe(1);
    expect(openOf(KID)).toHaveLength(1);
  });

  it('control: the row that stays holds the respawn key, so nothing comes back and the board says removed', async () => {
    // The approved one's successor was sent back (rejected, keyed); the to-do
    // removed is an unkeyed extra. 0256 refuses the sweep's insert.
    db.seed('chore_assignments', [
      finishedAndNext(KID, 'kid', '2026-10-12T19:00:01.000Z')[0],
      { id: 'asg-kid-sentback', family_id: FAMILY, chore_id: 'chore-bed', member_id: KID, status: 'rejected', due_at: '2026-10-13T18:00:00.000Z', idempotency_key: respawnKeyFor(FAMILY, 'asg-kid-done'), created_at: '2026-10-12T19:00:01.000Z' },
      { id: 'asg-kid-extra', family_id: FAMILY, chore_id: 'chore-bed', member_id: KID, status: 'todo', due_at: '2026-10-13T18:00:00.000Z', created_at: '2026-10-12T20:00:00.000Z' },
      ...finishedAndNext(SIB, 'sib', '2026-10-12T19:00:02.000Z'),
    ]);

    expect(await deleteChoreAssignmentAction('asg-kid-extra')).toEqual({ ok: true, id: 'asg-kid-extra', comesBack: false });

    const swept = await sweep();
    expect(swept.ok && swept.data.respawned).toBe(0);
    expect(openOf(KID)).toEqual([]);
  });
});
