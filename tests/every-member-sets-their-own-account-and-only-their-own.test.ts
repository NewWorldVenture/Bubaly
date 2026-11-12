// The three account actions in app/(app)/actions.ts, called as every family
// role with valid input, and with ids from a household the caller is not in.
//
// THE POLICY. These are per-ACCOUNT settings, not household data, so no family
// role narrows them and every member may use them for themselves only:
//   - user_preferences is own-row for every command (supabase/migrations/
//     01092_user_preferences_rls_repair.sql:19-32, `user_id = auth.uid()`);
//   - "Dashboard views available to every signed-in member" (lib/constants/
//     dashboards.ts:1), with PERSONAL_LABELS for all six roles (:19-26);
//   - the family switcher is rendered for every member (components/app/
//     app-shell.tsx:83-91, :151-157), and the action itself verifies the
//     caller belongs to the family before switching (app/(app)/actions.ts:42);
//   - the Profile tab of Settings is offered to every role (components/modules/
//     settings-module.tsx:49) and /settings is not withheld from a guest
//     (lib/auth/guest-scope.ts:18), and saveUserProfile writes only the
//     caller's own profile and own family_members rows (lib/server/profiles.ts:51, :73-76).
// A kid login is an ordinary account whose membership role is 'child'
// (lib/server/child-account.ts), so the child rows below are that login.
//
// WHAT IS ASSERTED: for each role, the call writes exactly the caller's own row
// and nothing of anyone else's; a family id from household B, which the caller
// does not belong to, is refused and changes nothing in A or B; a signed-out
// call is refused and writes nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAMILY_A, FAMILY_B, FAMILY_ROLES, memberIdOf, newAdminWorld, snapshot, userIdOf, type FamilyRole,
} from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  userId: null as string | null,
  revalidatePath: vi.fn(),
}));

/** The cookie client: the signed-in user, reading and writing the same tables. */
function cookieClient() {
  const db = h.db as InMemorySupabase;
  return {
    auth: { getUser: async () => ({ data: { user: h.userId ? { id: h.userId } : null }, error: null }) },
    from: (table: string) => db.from(table),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => cookieClient(),
  createServiceClient: () => h.db,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: vi.fn() }));

const { setActiveFamilyAction, setDefaultDashboardAction, updateMyProfileAction } = await import('@/app/(app)/actions');

/** A third household every member of A also belongs to, with the same role. */
const FAMILY_C = 'c0000000-0000-4000-8000-00000000000c';
const memberInC = (role: FamilyRole) => `c2000000-0000-4000-8000-00000000000${FAMILY_ROLES.indexOf(role) + 1}`;

let db: InMemorySupabase;

beforeEach(() => {
  h.revalidatePath.mockReset();
  db = newAdminWorld();
  h.db = db;
  h.userId = null;
  db.seed('families', [{ id: FAMILY_C, name: 'Household C' }]);
  db.seed('family_members', FAMILY_ROLES.map((role) => ({
    id: memberInC(role), family_id: FAMILY_C, user_id: userIdOf(role), role, display_name: `${role} C`, is_active: true,
  })));
  // Everyone in A and B starts on their own household, on the personal view.
  db.seed('user_preferences', FAMILY_ROLES.flatMap((role) => [
    { user_id: userIdOf(role, 'A'), active_family_id: FAMILY_A, default_dashboard: 'personal' },
    { user_id: userIdOf(role, 'B'), active_family_id: FAMILY_B, default_dashboard: 'personal' },
  ]));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const prefsOf = (userId: string) => db.table('user_preferences').filter((row) => row.user_id === userId);
const othersPrefs = (userId: string) => structuredClone(db.table('user_preferences').filter((row) => row.user_id !== userId));

const SWITCH = 'ACTION-0D0863DB430B';
describe(`${SWITCH} setActiveFamilyAction`, () => {
  it.each(FAMILY_ROLES)(`${SWITCH} the %s switches to another household they belong to; only their own preference moves`, async (role) => {
    h.userId = userIdOf(role);
    const others = othersPrefs(h.userId);

    expect(await setActiveFamilyAction(FAMILY_C)).toEqual({ ok: true });

    expect(prefsOf(h.userId)).toEqual([expect.objectContaining({ active_family_id: FAMILY_C, default_dashboard: 'personal' })]);
    expect(othersPrefs(h.userId)).toEqual(others);
    expect(h.revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout');
  });

  it.each(FAMILY_ROLES)(`${SWITCH} the %s of household A cannot switch into household B, and nothing changes`, async (role) => {
    h.userId = userIdOf(role);
    const before = snapshot(db);

    expect(await setActiveFamilyAction(FAMILY_B)).toEqual({ ok: false, error: 'actions.notAMemberOfThat' });

    expect(snapshot(db)).toEqual(before);
    expect(prefsOf(h.userId)).toEqual([expect.objectContaining({ active_family_id: FAMILY_A })]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it(`${SWITCH} a signed-out call is refused and writes nothing`, async () => {
    const before = snapshot(db);
    expect(await setActiveFamilyAction(FAMILY_A)).toEqual({ ok: false, error: 'actions.notSignedIn' });
    expect(snapshot(db)).toEqual(before);
  });
});

const DASH = 'ACTION-8C7A2BA78A66';
describe(`${DASH} setDefaultDashboardAction`, () => {
  it.each(FAMILY_ROLES)(`${DASH} the %s sets their own default to the family view; no one else's changes`, async (role) => {
    h.userId = userIdOf(role);
    const others = othersPrefs(h.userId);

    expect(await setDefaultDashboardAction('family')).toEqual({ ok: true });

    expect(prefsOf(h.userId)).toEqual([expect.objectContaining({ default_dashboard: 'family', active_family_id: FAMILY_A })]);
    expect(othersPrefs(h.userId)).toEqual(others);
  });

  it(`${DASH} a view that is not one of the two is refused before anything is written`, async () => {
    h.userId = userIdOf('teen');
    const before = snapshot(db);
    expect(await setDefaultDashboardAction('admin' as never)).toEqual({ ok: false, error: 'actions.invalidDashboard' });
    expect(snapshot(db)).toEqual(before);
  });

  it(`${DASH} a signed-out call is refused and writes nothing`, async () => {
    const before = snapshot(db);
    expect(await setDefaultDashboardAction('family')).toEqual({ ok: false, error: 'actions.notSignedIn' });
    expect(snapshot(db)).toEqual(before);
  });
});

const PROFILE = 'ACTION-42FEA397E048';
describe(`${PROFILE} updateMyProfileAction`, () => {
  // The Settings form always sends all four fields (components/modules/settings-module.tsx:118, :169).
  const input = { firstName: 'Robin', lastName: 'Example', phone: '+1 555 0100', avatarUrl: '' };

  it.each(FAMILY_ROLES)(`${PROFILE} the %s updates their own profile and their own member names only`, async (role) => {
    h.userId = userIdOf(role);
    const othersProfiles = structuredClone(db.table('profiles').filter((row) => row.id !== h.userId));
    const othersMembers = structuredClone(db.table('family_members').filter((row) => row.user_id !== h.userId));

    expect(await updateMyProfileAction(input)).toEqual({ ok: true });

    expect(db.table('profiles').filter((row) => row.id === h.userId)).toEqual([
      expect.objectContaining({ full_name: 'Robin Example', display_name: 'Robin', avatar_url: null }),
    ]);
    // Their membership in A and in C both follow the new first name.
    expect(db.table('family_members').filter((row) => row.user_id === h.userId).map((row) => [row.id, row.display_name]))
      .toEqual([[memberIdOf(role, 'A'), 'Robin'], [memberInC(role), 'Robin']]);
    // Household B, and every other member of A and C, are untouched.
    expect(db.table('profiles').filter((row) => row.id !== h.userId)).toEqual(othersProfiles);
    expect(db.table('family_members').filter((row) => row.user_id !== h.userId)).toEqual(othersMembers);
  });

  it(`${PROFILE} a signed-out call is refused and writes nothing`, async () => {
    const before = snapshot(db);
    expect(await updateMyProfileAction(input)).toEqual({ ok: false, error: 'actions.notSignedIn' });
    expect(snapshot(db)).toEqual(before);
  });

  it(`${PROFILE} an invalid name is refused before anything is written`, async () => {
    h.userId = userIdOf('parent');
    const before = snapshot(db);
    expect(await updateMyProfileAction({ ...input, firstName: '  ' })).toEqual({ ok: false, error: 'Enter your first name' });
    expect(snapshot(db)).toEqual(before);
  });
});
