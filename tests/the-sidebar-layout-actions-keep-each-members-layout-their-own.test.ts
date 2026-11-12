// Call-level role tests for the sidebar layout actions
// (app/(app)/dashboard/navigation-actions.ts), Register B group 4.
//
// THE POLICY: a sidebar layout is the signed-in USER's, not the household's.
// It lives in user_preferences.notification_prefs under the user's own row
// (the action's header comment: "scoped to the signed-in user by that table's
// own-row RLS"), so every role saves and reads its own layout and nobody's
// else — not another member of the same household, not a member of another
// household. Neither action takes an id: the only identity it can act for is
// the caller's. Manager-only destinations are filtered when the sidebar is
// RENDERED (lib/constants/navigation.ts:16-31), so storing a key is not a
// grant and is not a role question.
//
// The real exported actions and the real lib/services/navigation run against
// tests/helpers/in-memory-supabase.ts; only the signed-in context and the
// translator are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { loadSidebarPrefs, saveSidebarNavAction } = await import('@/app/(app)/dashboard/navigation-actions');

const FAMILY_A = '00000000-0000-4000-8000-0000000000a1';
const SIBLING_USER = '00000000-0000-4000-8000-0000000009a1';
const OTHER_FAMILY_USER = '00000000-0000-4000-8000-0000000009b1';

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';
type Caller = { label: string; role: Role; userId: string; email: string };
const CALLERS: Caller[] = [
  { label: 'parent', role: 'parent', userId: '00000000-0000-4000-8000-0000000001a1', email: 'parent@example.com' },
  { label: 'adult', role: 'adult', userId: '00000000-0000-4000-8000-0000000002a1', email: 'adult@example.com' },
  { label: 'teen', role: 'teen', userId: '00000000-0000-4000-8000-0000000003a1', email: 'teen@example.com' },
  { label: 'child', role: 'child', userId: '00000000-0000-4000-8000-0000000004a1', email: 'child@example.com' },
  { label: 'child on a kid login', role: 'child', userId: '00000000-0000-4000-8000-0000000005a1', email: 'kid-0001@kids.example.com' },
  { label: 'caregiver', role: 'caregiver', userId: '00000000-0000-4000-8000-0000000006a1', email: 'caregiver@example.com' },
  { label: 'guest', role: 'guest', userId: '00000000-0000-4000-8000-0000000007a1', email: 'guest@example.com' },
];

const SIBLING_PREFS = { sidebarNav: ['/dashboard/chores'], digest: true };
const OTHER_FAMILY_PREFS = { sidebarNav: ['/dashboard/bills'], sidebarNavChildren: { '/dashboard/home': ['/dashboard/home/pros'] } };

let db: InMemorySupabase;

function signInAs(caller: Caller) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: caller.userId, email: caller.email },
    memberships: [],
    active: {
      familyId: FAMILY_A,
      family: { id: FAMILY_A, timezone: 'America/New_York' },
      role: caller.role,
      member: { id: `member-${caller.userId}` },
    },
  });
}

const prefsOf = (userId: string): Row | undefined =>
  db.table('user_preferences').find((r) => r.user_id === userId)?.notification_prefs as Row | undefined;
const othersRows = (userId: string) => structuredClone(db.table('user_preferences').filter((r) => r.user_id !== userId));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  mocks.createServer.mockResolvedValue(db);
  db.seed('user_preferences', [
    { user_id: SIBLING_USER, notification_prefs: SIBLING_PREFS, updated_at: '2026-01-01T00:00:00.000Z' },
    { user_id: OTHER_FAMILY_USER, notification_prefs: OTHER_FAMILY_PREFS, updated_at: '2026-01-01T00:00:00.000Z' },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('saveSidebarNavAction', () => {
  it.each(CALLERS)('ACTION-0C414E002599 a $label saves a first layout to their own preferences only', async (caller) => {
    signInAs(caller);
    const others = othersRows(caller.userId);
    const result = await saveSidebarNavAction({
      keys: ['/dashboard/calendar', '/dashboard/meals', '/dashboard/settings'],
      children: { '/dashboard/home': ['/dashboard/home/service'] },
    });
    // Settings is fixed chrome and is never stored in the customizable list.
    expect(result).toEqual({ ok: true, nav: ['/dashboard/calendar', '/dashboard/meals'], children: { '/dashboard/home': ['/dashboard/home/service'] } });
    expect(prefsOf(caller.userId)).toEqual({
      sidebarNav: ['/dashboard/calendar', '/dashboard/meals'],
      sidebarNavChildren: { '/dashboard/home': ['/dashboard/home/service'] },
    });
    expect(othersRows(caller.userId)).toEqual(others);
  });

  it.each(CALLERS)('ACTION-0C414E002599 a $label changes their saved layout and keeps their other preferences', async (caller) => {
    signInAs(caller);
    // The same updated_at as the other two rows, so the concurrency guard alone
    // cannot tell them apart: only the user filter keeps the write to this row.
    db.seed('user_preferences', [{ user_id: caller.userId, notification_prefs: { sidebarNav: ['/dashboard/lists'], quietHours: '22-7' }, updated_at: '2026-01-01T00:00:00.000Z' }]);
    const others = othersRows(caller.userId);
    await expect(saveSidebarNavAction({ keys: ['/dashboard/meals'] })).resolves.toMatchObject({ ok: true, nav: ['/dashboard/meals'] });
    expect(prefsOf(caller.userId)).toEqual({ sidebarNav: ['/dashboard/meals'], quietHours: '22-7' });
    expect(othersRows(caller.userId)).toEqual(others);
    expect(prefsOf(SIBLING_USER)).toEqual(SIBLING_PREFS);
    expect(prefsOf(OTHER_FAMILY_USER)).toEqual(OTHER_FAMILY_PREFS);
  });

  it('ACTION-0C414E002599 a signed-out caller saves nothing', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));
    const before = structuredClone(db.table('user_preferences'));
    await expect(saveSidebarNavAction({ keys: ['/dashboard/meals'] })).rejects.toThrow('NEXT_REDIRECT');
    expect(db.table('user_preferences')).toEqual(before);
  });
});

describe('loadSidebarPrefs', () => {
  it.each(CALLERS)('ACTION-C5EF1ECD4052 a $label reads their own layout, never another member\'s', async (caller) => {
    signInAs(caller);
    db.seed('user_preferences', [{ user_id: caller.userId, notification_prefs: { sidebarNav: ['/dashboard/lists'] }, updated_at: '2026-02-01T00:00:00.000Z' }]);
    const before = structuredClone(db.table('user_preferences'));
    await expect(loadSidebarPrefs()).resolves.toEqual({ nav: ['/dashboard/lists'], children: null });
    expect(db.table('user_preferences')).toEqual(before);
  });

  it.each(CALLERS)('ACTION-C5EF1ECD4052 a $label with no layout of their own gets none, not a sibling\'s or another family\'s', async (caller) => {
    signInAs(caller);
    await expect(loadSidebarPrefs()).resolves.toEqual({ nav: null, children: null });
  });

  it('ACTION-C5EF1ECD4052 a signed-out caller reads nothing', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));
    await expect(loadSidebarPrefs()).rejects.toThrow('NEXT_REDIRECT');
  });
});
