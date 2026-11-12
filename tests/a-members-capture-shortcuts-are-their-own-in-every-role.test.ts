// Call-level role tests for the capture shortcut layout
// (app/(app)/capture/shortcuts-actions.ts), Register B ACTION-B6D27445070B
// (loadCaptureShortcuts) and ACTION-8545A131965A (saveCaptureShortcutsAction).
//
// THE POLICY. A shortcut layout is a personal preference, stored in the
// signed-in user's own `user_preferences.notification_prefs` row. The table's
// live policy is own-row for every command (0118_rls_drift_repair.sql:138,
// `prefs_all ... using (user_id = auth.uid())`), and the action's comment says
// the same. No role is narrowed: a parent, an adult, a teen, a child (a kid PIN
// login is a child member like any other), a caregiver and a guest each read
// and save their OWN layout, and only it. The actions take no id, so "another
// family" here is another user's row: it must never be read or written, and
// every other key in the caller's own blob (App Lock, Google tokens) must
// survive a save.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ db: null as unknown, requireUserContext: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));

const { loadCaptureShortcuts, saveCaptureShortcutsAction } = await import('@/app/(app)/capture/shortcuts-actions');

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const userFor = (role: string) => `user-a-${role}`;
const OTHER_USER = 'user-b-parent';

let db: InMemorySupabase;

function signInAs(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: userFor(role), email: `${role}@example.com` },
    active: { familyId: FAMILY_A, role, member: { id: `member-a-${role}` }, family: { id: FAMILY_A, timezone: 'UTC' } },
  });
}

const rowOf = (userId: string) => db.table('user_preferences').find((r) => r.user_id === userId);

beforeEach(() => {
  vi.resetAllMocks();
  db = createInMemorySupabase({ uniques: { user_preferences: [['user_id']] } });
  mocks.db = db;
  // Every member of A has a saved row with an App Lock key and a layout; the
  // other household's parent has their own, different layout.
  db.seed('user_preferences', [
    ...ROLES.map((role) => ({
      user_id: userFor(role), active_family_id: FAMILY_A,
      notification_prefs: { appLock: { enabled: true }, captureShortcuts: ['calendar', role] },
    })),
    { user_id: OTHER_USER, active_family_id: FAMILY_B, notification_prefs: { captureShortcuts: ['their-own'], googleToken: 'tok-b' } },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('loadCaptureShortcuts', () => {
  it.each(ROLES)('ACTION-B6D27445070B signed in as %s, a member reads their own saved layout, never the other household member\'s', async (role) => {
    signInAs(role);
    expect(await loadCaptureShortcuts()).toEqual({ ok: true, keys: ['calendar', role] });
  });

  it('ACTION-B6D27445070B a member with no saved row reads "never customised", not another user\'s layout', async () => {
    db.replace('user_preferences', db.table('user_preferences').filter((r) => r.user_id !== userFor('teen')));
    signInAs('teen');
    expect(await loadCaptureShortcuts()).toEqual({ ok: true, keys: null });
  });
});

describe('saveCaptureShortcutsAction', () => {
  it.each(ROLES)('ACTION-8545A131965A signed in as %s, a member saves their own layout, keeps their other preferences, and touches no one else\'s row', async (role) => {
    signInAs(role);
    const others = structuredClone(db.table('user_preferences').filter((r) => r.user_id !== userFor(role)));

    expect(await saveCaptureShortcutsAction({ keys: ['tasks', 'tasks', 'grocery', 'home'] })).toEqual({ ok: true });

    expect(rowOf(userFor(role))?.notification_prefs).toEqual({ appLock: { enabled: true }, captureShortcuts: ['tasks', 'grocery', 'home'] });
    expect(db.table('user_preferences').filter((r) => r.user_id !== userFor(role))).toEqual(others);
    expect(rowOf(OTHER_USER)?.notification_prefs).toEqual({ captureShortcuts: ['their-own'], googleToken: 'tok-b' });
  });

  it('ACTION-8545A131965A a member with no row gets one of their own, and the other household\'s row is unchanged', async () => {
    db.replace('user_preferences', db.table('user_preferences').filter((r) => r.user_id !== userFor('guest')));
    signInAs('guest');
    const before = structuredClone(db.table('user_preferences'));

    expect(await saveCaptureShortcutsAction({ keys: ['calendar'] })).toEqual({ ok: true });

    expect(db.table('user_preferences')).toHaveLength(before.length + 1);
    expect(rowOf(userFor('guest'))?.notification_prefs).toEqual({ captureShortcuts: ['calendar'] });
    expect(db.table('user_preferences').filter((r) => r.user_id !== userFor('guest'))).toEqual(before);
  });
});
