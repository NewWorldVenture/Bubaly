import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, has, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The chores board, driven as a parent drives it: the REAL ChoresModule, its
// own reads (against an in-memory database capped at PostgREST's db-max-rows,
// 1,000) and the REAL server actions behind its buttons.
//
//   S2   a failed `chores` read was dropped: every row rendered as an untitled
//        0-point chore, and Approve wrote points_awarded 0 for good, toasted
//        "+0 pts" and skipped the recurring successor
//   S6   Redo sent 'rejected' to setChoreStatusAction, which refuses it, so
//        every Redo failed with "That is not a status a member can set."
//   S12  one unpaged read: past 1,000 assignments the all-time points and the
//        oldest open or submitted chores were cut off without a word

type Fetcher = (client: unknown) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const live = vi.hoisted(() => ({
  queries: new Map<string, { fetcher: Fetcher; data: unknown[]; error: string | null; loaded: boolean }>(),
}));
const session = vi.hoisted(() => ({ role: 'parent', memberId: 'member-1' }));

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
      familyId: h.app.familyId, role: session.role,
      member: { id: session.memberId, family_id: h.app.familyId },
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

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const PARENT = 'member-1';
const KID = 'member-2';
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  resetHookSlots(h.hooks);
  live.queries.clear();
  // PostgREST's db-max-rows on a default Supabase project.
  db = createInMemorySupabase({
    maxRows: 1000,
    defaults: {
      chores: { description: null, points: 10, priority: 'medium', recurrence: 'none', due_at: null, requires_approval: true, icon: null, is_active: true, cash_cents: null },
      chore_assignments: { status: 'todo', due_at: null, submitted_at: null, approved_at: null, approved_by: null, points_awarded: null, ai_score: null, cash_awarded_cents: null, idempotency_key: null, disputed: false },
    },
  });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  h.app.members = [
    { id: PARENT, display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: KID, display_name: 'Bo', role: 'child', is_active: true, color: null, birthday: null },
  ];
  h.app.selfMember = h.app.members[0];
  (h.app as Record<string, unknown>).role = 'parent';
  session.role = 'parent';
  session.memberId = PARENT;
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, display_name: 'Ada', role: 'parent', is_active: true },
    { id: KID, family_id: FAMILY, display_name: 'Bo', role: 'child', is_active: true },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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

const approvalsTab = (tree: ReactNode) => byName(tree, new RegExp(`^${t('choresModule.tab.approvals')}\\d*$`));
const assignment = (id: string) => db.table('chore_assignments').find((row) => row.id === id)!;

describe('S2 — a chore read that failed is a board that failed, not a board of 0-point chores', () => {
  beforeEach(() => {
    db.seed('chores', [{ id: 'chore-bed', family_id: FAMILY, title: 'Make the bed', points: 25, recurrence: 'daily' }]);
    db.seed('chore_assignments', [{ id: 'asg-1', family_id: FAMILY, chore_id: 'chore-bed', member_id: KID, status: 'submitted', submitted_at: '2026-10-13T09:00:00Z', created_at: '2026-10-13T08:00:00Z' }]);
  });

  it('shows the error state, offers no Approve, and writes nothing, when only the chores read fails', async () => {
    h.fault = (table, calls) => (table === 'chores' && calls.includes('select') ? { message: 'upstream timeout' } : null);

    const tree = await show();

    expect(nodes(tree).some((n) => n.props.role === 'alert')).toBe(true);
    expect(allByName(tree, t('chores.approve'))).toHaveLength(0);
    expect(has(tree, t('choresModule.approvedPlusPoints', { points: 0 }))).toBe(false);
    expect(assignment('asg-1')).toMatchObject({ status: 'submitted', points_awarded: null });
  });

  it('with the read healthy, the same Approve awards the chore\'s own points', async () => {
    const tree = await show();
    await click(approvalsTab(tree));
    await click(byName(await show(), t('chores.approve')));

    expect(assignment('asg-1')).toMatchObject({ status: 'approved', points_awarded: 25 });
    expect(h.toasts.success).toContain(t('choresModule.approvedPlusPoints', { points: 25 }));
  });

  it('refuses to approve a row whose chore it could not load, rather than paying 0 for good', async () => {
    // An assignment whose chore is not in the family's list: nothing to price it from.
    db.seed('chore_assignments', [{ id: 'asg-orphan', family_id: FAMILY, chore_id: 'chore-missing', member_id: KID, status: 'submitted', submitted_at: '2026-10-13T10:00:00Z', created_at: '2026-10-13T10:00:00Z' }]);
    const tree = await show();
    await click(approvalsTab(tree));
    const approvals = await show();
    // The orphan is the newest submission, listed first.
    await click(allByName(approvals, t('chores.approve'))[0]);

    expect(assignment('asg-orphan')).toMatchObject({ status: 'submitted', points_awarded: null });
    expect(h.toasts.error).toContain(t('choresModule.failedToLoadChores'));
    expect(h.toasts.success).toEqual([]);
  });
});

describe('S6 — Redo sends a submitted chore back, through a door that takes it', () => {
  beforeEach(() => {
    db.seed('chores', [{ id: 'chore-dishes', family_id: FAMILY, title: 'Unload the dishwasher', points: 15 }]);
    db.seed('chore_assignments', [{ id: 'asg-redo', family_id: FAMILY, chore_id: 'chore-dishes', member_id: KID, status: 'submitted', submitted_at: '2026-10-13T09:00:00Z' }]);
  });

  it('marks the chore "needs redo" and says so', async () => {
    const tree = await show();
    await click(approvalsTab(tree));
    await click(byName(await show(), t('chores.redo')));

    expect(h.toasts.error).toEqual([]);
    expect(assignment('asg-redo').status).toBe('rejected');
    expect(h.toasts.success).toContain(t('choresModule.sentBackForRedo'));
    // The board re-read: the chore left the approvals queue.
    const after = await show();
    expect(allByName(after, t('chores.redo'))).toHaveLength(0);
  });

  it('only from "submitted": a chore approved meanwhile is not pulled back by a stale screen', async () => {
    const tree = await show();
    await click(approvalsTab(tree));
    const approvals = await show();
    assignment('asg-redo').status = 'approved';
    await click(byName(approvals, t('chores.redo')));

    expect(assignment('asg-redo').status).toBe('approved');
    expect(h.toasts.error).toHaveLength(1);
  });

  it('is a manager\'s decision on the server too', async () => {
    const { rejectChoreAssignmentAction } = await import('@/app/(app)/dashboard/chores/actions');
    session.role = 'child';
    session.memberId = KID;

    const result = await rejectChoreAssignmentAction('asg-redo');

    expect(result.ok).toBe(false);
    expect(assignment('asg-redo').status).toBe('submitted');
  });
});

describe('S12 — the board reads every assignment, not the newest 1,000', () => {
  /** An hour apart from 1 January 2026, oldest first. */
  const hour = (n: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 3_600_000).toISOString();

  beforeEach(() => {
    db.seed('chores', [
      { id: 'chore-old', family_id: FAMILY, title: 'Wash the car', points: 40 },
      { id: 'chore-daily', family_id: FAMILY, title: 'Feed the cat', points: 1, recurrence: 'daily' },
    ]);
    // The oldest row: a submission still waiting for a parent.
    db.seed('chore_assignments', [{ id: 'asg-0000', family_id: FAMILY, chore_id: 'chore-old', member_id: KID, status: 'submitted', submitted_at: hour(0), created_at: hour(0) }]);
    // Then 1,100 approved dailies, one point each.
    db.seed('chore_assignments', Array.from({ length: 1100 }, (_, i) => ({
      id: `asg-${String(i + 1).padStart(4, '0')}`, family_id: FAMILY, chore_id: 'chore-daily', member_id: KID,
      status: 'approved', points_awarded: 1, created_at: hour(i + 1),
    })));
  });

  it('lists the oldest submission and counts all 1,100 points', async () => {
    const tree = await show();

    // The "Need approval" rail names the old submission's chore, and the tab counts it…
    expect(has(tree, 'Wash the car')).toBe(true);
    expect(text(approvalsTab(tree))).toBe(`${t('choresModule.tab.approvals')}1`);
    // …and the family total is every approved point, not the newest thousand's.
    expect(has(tree, '1100')).toBe(true);
  });
});
