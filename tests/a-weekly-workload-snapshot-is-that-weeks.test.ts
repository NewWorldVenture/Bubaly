import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// N19 — the Workload page's weekly snapshot, the REAL module and the REAL
// action it calls, against an in-memory database.
//
// The page's live report is the ROLLING seven days before the view, and the
// module filed that report as the row for this ISO week's Monday on every page
// view, by anyone. A look on Monday at 08:00 wrote last week's work into this
// week's row, so "X carried N% for 6 straight weeks" was shifted by up to a
// week and decided by who looked when — a child's view included.

const h = await vi.hoisted(async () => ({ ...(await import('./helpers/module-state')).createModuleState(), role: 'parent' }));
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-mum' },
    active: { familyId: 'family-1', role: h.role, member: { id: 'mum' }, family: { name: 'Fixture', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));

const { WorkloadModule } = await import('@/components/modules/workload-module');

const FAMILY = 'family-1';
let db: InMemorySupabase;

const MEMBERS = [
  { id: 'mum', display_name: 'Mum', role: 'parent', color: null, user_id: 'user-mum' },
  { id: 'dad', display_name: 'Dad', role: 'parent', color: null, user_id: 'user-dad' },
];
const CHORES = [{ id: 'chore-1', title: 'Deep clean the kitchen', est_minutes: 90, points: 10 }];
/** Sunday's big job is LAST week's; Monday's small one is this week's. */
const SUNDAY_JOB = { id: 'a-sun', chore_id: 'chore-1', member_id: 'mum', status: 'done', created_at: '2026-10-11T10:00:00.000Z' };
const MONDAY_JOB = { id: 'a-mon', chore_id: 'chore-1', member_id: 'dad', status: 'todo', created_at: '2026-10-12T07:00:00.000Z' };

/** The module as the page renders it: its props are the rolling seven days, which include Sunday. */
const view = () => createElement(WorkloadModule, {
  familyId: FAMILY, members: MEMBERS, chores: CHORES, assignments: [SUNDAY_JOB, MONDAY_JOB], todos: [], events: [], snapshots: [],
});
const snapshot = (memberId: string) => db.table('workload_snapshots').find((row) => row.member_id === memberId && row.week_start === '2026-10-12');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Monday 12 October, 08:00 on the family's clock.
  vi.setSystemTime(new Date('2026-10-12T08:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.role = 'parent';
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', MEMBERS.map((m) => ({ ...m, family_id: FAMILY, is_active: true })));
  db.seed('chores', CHORES.map((c) => ({ ...c, family_id: FAMILY })));
  db.seed('chore_assignments', [SUNDAY_JOB, MONDAY_JOB].map((a) => ({ ...a, family_id: FAMILY })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the week\'s snapshot is that ISO week\'s work', () => {
  it('a Monday-morning view files only Monday\'s work under this Monday', async () => {
    render(h.hooks, view());
    for (let i = 0; i < 5; i++) await settle();
    expect(h.toasts.error).toEqual([]);
    expect(snapshot('dad')).toMatchObject({ chore_count: 1, share_pct: 100 });
    // Sunday's job belongs to last week's row, not this one.
    expect(snapshot('mum')).toMatchObject({ chore_count: 0, share_pct: 0 });
  });

  it.each(['child', 'teen', 'guest'])('a %s\'s view does not rewrite the household\'s history', async (role) => {
    h.role = role;
    render(h.hooks, view());
    for (let i = 0; i < 5; i++) await settle();
    expect(db.table('workload_snapshots')).toEqual([]);
    expect(h.toasts.error).toEqual([]);
  });
});
