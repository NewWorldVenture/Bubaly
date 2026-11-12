// Call-level role tests for app/(app)/dashboard/customize-actions.ts.
//
// THE POLICY, from the sources rather than from what the actions do:
//   - A member writes only their OWN personal layout (scope 'user', user_id =
//     the signed-in user); the family default and other members' layouts are a
//     manager's. 0357's dashboard_layouts policies:
//     `can_manage_family(family_id) or (scope = 'user' and user_id = auth.uid())`.
//   - family_dashboard_settings is manager-written (0357), and its two flags
//     decide whether a non-manager may customize at all
//     (lib/dashboard/permissions.ts canCustomizeDashboard).
//   - The layout may only hold features the family's plan reaches
//     (lib/dashboard/layout.ts validateLayout, tier from the family plan, a
//     super admin bumped to Family+ by effectivePlanLevel).
//   - dashboard_layout_events is append-only and first-person (0481:597-599).
//
// Everything below the session is the real code: the actions, the plan
// resolution (lib/server/plan.ts, on the service client), effectivePlanLevel
// and isSuperAdmin. Only the session (requireUserContext), the two client
// factories (both answered by one in-memory store), the translator and
// next/cache are stubbed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  revalidatePath: vi.fn(),
  db: null as unknown,
}));

vi.mock('@/lib/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/auth')>()),
  requireUserContext: mocks.requireUserContext,
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => mocks.db,
  createServiceClient: () => mocks.db,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const {
  logDashboardEventAction, resetAllLayoutsAction, resetDashboardLayoutAction,
  saveDashboardLayoutAction, saveDashboardSettingsAction, saveFamilyDefaultLayoutAction,
} = await import('@/app/(app)/dashboard/customize-actions');

const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = (typeof ROLES)[number];
const MANAGERS = ['parent', 'adult'] as const;
const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'] as const;

const USER: Record<Role | 'kid' | 'sibling' | 'other', string> = {
  parent: 'a0000000-0000-4000-8000-0000000000a1',
  adult: 'a0000000-0000-4000-8000-0000000000a2',
  teen: 'a0000000-0000-4000-8000-0000000000a3',
  child: 'a0000000-0000-4000-8000-0000000000a4',
  caregiver: 'a0000000-0000-4000-8000-0000000000a5',
  guest: 'a0000000-0000-4000-8000-0000000000a6',
  kid: 'a0000000-0000-4000-8000-0000000000a7',
  sibling: 'a0000000-0000-4000-8000-0000000000a8',
  other: 'b0000000-0000-4000-8000-0000000000b1',
};

let db: InMemorySupabase;
let superAdmin = false;

/** A signed-in member of household A (or of B when `family` says so). */
function signedInAs(role: Role, opts: { family?: string; user?: string; email?: string } = {}) {
  const userId = opts.user ?? USER[role];
  const familyId = opts.family ?? FAMILY_A;
  mocks.requireUserContext.mockResolvedValue({
    user: { id: userId, email: opts.email ?? `${role}@example.com` },
    memberships: [],
    active: { familyId, family: { id: familyId, timezone: 'UTC' }, role, member: { id: `member-${userId}` } },
  });
  db = makeDb(userId, db);
  mocks.db = db;
}

/** The kid PIN login: a child member whose auth email is on the kid domain. */
function signedInAsKidLogin() {
  signedInAs('child', { user: USER.kid, email: `mia@${CHILD_LOGIN_EMAIL_DOMAIN}` });
}

function signedOut() {
  mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));
}

/** One store; re-pointed at a new signed-in user without losing its rows. */
function makeDb(userId: string, previous?: InMemorySupabase): InMemorySupabase {
  const next = createInMemorySupabase({
    userId,
    uniques: {
      dashboard_layouts: [['family_id', 'user_id', 'device_context']],
      family_dashboard_settings: [['family_id']],
    },
    rpc: { is_super_admin: () => superAdmin },
  });
  if (previous) {
    for (const name of TABLES) next.replace(name, previous.table(name));
  }
  return next;
}

const TABLES = ['families', 'subscriptions', 'dashboard_layouts', 'family_dashboard_settings', 'dashboard_layout_events'];

/** Every row the actions could touch, deep-copied. */
const snapshot = () => Object.fromEntries(
  ['dashboard_layouts', 'family_dashboard_settings', 'dashboard_layout_events'].map((t) => [t, structuredClone(db.table(t))]),
);

const layouts = (filter: (r: Row) => boolean) => db.table('dashboard_layouts').filter(filter);
const events = () => db.table('dashboard_layout_events');

/** Household A on Family Basic (level 1), household B on Family+ (level 2), each with existing rows. */
function seedHouseholds(planA: 'basic' | 'plus' | null = 'basic') {
  db.seed('families', [
    { id: FAMILY_A, trial_ends_at: null, closed_at: null },
    { id: FAMILY_B, trial_ends_at: null, closed_at: null },
  ]);
  db.seed('subscriptions', [
    ...(planA ? [{ family_id: FAMILY_A, plan: planA, status: 'active', current_period_end: '2099-01-01T00:00:00Z' }] : []),
    { family_id: FAMILY_B, plan: 'plus', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ]);
  db.seed('dashboard_layouts', [
    // A sibling's own layout in A: nobody but a manager may touch it.
    { id: 'lay-a-sibling', family_id: FAMILY_A, user_id: USER.sibling, scope: 'user', device_context: 'all', feature_keys: ['grocery'], is_active: true },
    // A's family default.
    { id: 'lay-a-family', family_id: FAMILY_A, user_id: null, scope: 'family', device_context: 'all', feature_keys: ['calendar'], is_active: true },
    // B's rows, including a personal layout of a user who shares an id with A's parent
    // (one person in two households).
    { id: 'lay-b-user', family_id: FAMILY_B, user_id: USER.other, scope: 'user', device_context: 'all', feature_keys: ['calendar'], is_active: true },
    { id: 'lay-b-parent', family_id: FAMILY_B, user_id: USER.parent, scope: 'user', device_context: 'all', feature_keys: ['notes'], is_active: true },
    { id: 'lay-b-family', family_id: FAMILY_B, user_id: null, scope: 'family', device_context: 'all', feature_keys: ['command_center'], is_active: true },
  ]);
  db.seed('family_dashboard_settings', [
    { family_id: FAMILY_B, allow_child_customization: false, lock_to_family_default: true },
  ]);
}

const familyBRows = () => structuredClone({
  layouts: db.table('dashboard_layouts').filter((r) => r.family_id === FAMILY_B),
  settings: db.table('family_dashboard_settings').filter((r) => r.family_id === FAMILY_B),
  events: db.table('dashboard_layout_events').filter((r) => r.family_id === FAMILY_B),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  superAdmin = false;
  db = makeDb(USER.parent);
  mocks.db = db;
  seedHouseholds();
});

describe('saveDashboardLayoutAction: a member saves their own layout, within the plan and the parents\' settings', () => {
  it.each(ROLES)('ACTION-6DDA408B62AE %s saves exactly their own user-scope layout in household A', async (role) => {
    signedInAs(role);
    const before = familyBRows();
    const sibling = structuredClone(layouts((r) => r.id === 'lay-a-sibling'));
    const familyDefault = structuredClone(layouts((r) => r.id === 'lay-a-family'));

    await expect(saveDashboardLayoutAction({ featureKeys: ['calendar', 'goals'], deviceContext: 'mobile' })).resolves.toEqual({ ok: true });

    const mine = layouts((r) => r.user_id === USER[role] && r.family_id === FAMILY_A);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      family_id: FAMILY_A, user_id: USER[role], scope: 'user', device_context: 'mobile',
      feature_keys: ['calendar', 'goals'], created_by: USER[role], updated_by: USER[role],
    });
    expect(layouts((r) => r.id === 'lay-a-sibling'), 'another member\'s layout is untouched').toEqual(sibling);
    expect(layouts((r) => r.id === 'lay-a-family'), 'the family default is untouched').toEqual(familyDefault);
    expect(familyBRows(), 'household B is untouched').toEqual(before);
    expect(events()).toEqual([expect.objectContaining({ family_id: FAMILY_A, user_id: USER[role], action: 'customized' })]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard');
  });

  it('ACTION-6DDA408B62AE a kid login saves its own layout while the family allows children to customize', async () => {
    signedInAsKidLogin();
    await expect(saveDashboardLayoutAction({ featureKeys: ['calendar'] })).resolves.toEqual({ ok: true });
    expect(layouts((r) => r.user_id === USER.kid)).toEqual([expect.objectContaining({ family_id: FAMILY_A, scope: 'user', device_context: 'all', feature_keys: ['calendar'] })]);
  });

  it.each(NON_MANAGERS)('ACTION-6DDA408B62AE %s is refused, and writes nothing, when a parent turned child customization off', async (role) => {
    db.seed('family_dashboard_settings', [{ family_id: FAMILY_A, allow_child_customization: false, lock_to_family_default: false }]);
    signedInAs(role);
    const before = snapshot();
    await expect(saveDashboardLayoutAction({ featureKeys: ['calendar'] }))
      .resolves.toEqual({ ok: false, error: 'A parent has turned off dashboard customization for children.' });
    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(NON_MANAGERS)('ACTION-6DDA408B62AE %s is refused, and writes nothing, when the family is locked to its default', async (role) => {
    db.seed('family_dashboard_settings', [{ family_id: FAMILY_A, allow_child_customization: true, lock_to_family_default: true }]);
    signedInAs(role);
    const before = snapshot();
    await expect(saveDashboardLayoutAction({ featureKeys: ['calendar'] }))
      .resolves.toEqual({ ok: false, error: 'Your family uses a shared dashboard set by a parent.' });
    expect(snapshot()).toEqual(before);
  });

  it.each(MANAGERS)('ACTION-6DDA408B62AE %s still saves their own layout when customization is off and locked', async (role) => {
    db.seed('family_dashboard_settings', [{ family_id: FAMILY_A, allow_child_customization: false, lock_to_family_default: true }]);
    signedInAs(role);
    await expect(saveDashboardLayoutAction({ featureKeys: ['calendar'] })).resolves.toEqual({ ok: true });
    expect(layouts((r) => r.user_id === USER[role] && r.family_id === FAMILY_A)).toHaveLength(1);
  });

  it('ACTION-6DDA408B62AE household B\'s lock does not govern a child of household A', async () => {
    // B is locked and closed to children; A has no settings row (permissive by default).
    signedInAs('child');
    await expect(saveDashboardLayoutAction({ featureKeys: ['calendar'] })).resolves.toEqual({ ok: true });
  });

  it('ACTION-6DDA408B62AE a feature above the family\'s plan is refused for every role, and nothing is written', async () => {
    for (const role of ROLES) {
      signedInAs(role);
      const before = snapshot();
      await expect(saveDashboardLayoutAction({ featureKeys: ['command_center'] }), role)
        .resolves.toEqual({ ok: false, error: 'Command Center requires an upgrade.' });
      expect(snapshot(), role).toEqual(before);
    }
  });

  it('ACTION-6DDA408B62AE a basic feature is refused to a free household, and allowed once a super admin is the caller', async () => {
    db.replace('subscriptions', db.table('subscriptions').filter((s) => s.family_id !== FAMILY_A));
    signedInAs('parent');
    await expect(saveDashboardLayoutAction({ featureKeys: ['goals'] }))
      .resolves.toEqual({ ok: false, error: 'Goals requires an upgrade.' });
    expect(layouts((r) => r.family_id === FAMILY_A && r.user_id === USER.parent)).toEqual([]);

    superAdmin = true;
    await expect(saveDashboardLayoutAction({ featureKeys: ['goals', 'command_center'] })).resolves.toEqual({ ok: true });
    expect(layouts((r) => r.family_id === FAMILY_A && r.user_id === USER.parent)[0]?.feature_keys).toEqual(['goals', 'command_center']);
  });

  it('ACTION-6DDA408B62AE a parent of both households saving in A leaves their B layout alone', async () => {
    signedInAs('parent');
    await expect(saveDashboardLayoutAction({ featureKeys: ['calendar'] })).resolves.toEqual({ ok: true });
    expect(layouts((r) => r.id === 'lay-b-parent')).toEqual([expect.objectContaining({ family_id: FAMILY_B, feature_keys: ['notes'] })]);
    expect(layouts((r) => r.user_id === USER.parent && r.family_id === FAMILY_A)).toHaveLength(1);
  });

  it('ACTION-6DDA408B62AE a signed-out caller is sent to login and nothing is written', async () => {
    signedOut();
    const before = snapshot();
    await expect(saveDashboardLayoutAction({ featureKeys: ['calendar'] })).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});

describe('resetDashboardLayoutAction: a member resets only their own layout', () => {
  it.each(ROLES)('ACTION-664724EB6103 %s removes their own layout for that device and nothing else', async (role) => {
    db.seed('dashboard_layouts', [
      { id: `mine-${role}-mobile`, family_id: FAMILY_A, user_id: USER[role], scope: 'user', device_context: 'mobile', feature_keys: ['calendar'] },
      { id: `mine-${role}-all`, family_id: FAMILY_A, user_id: USER[role], scope: 'user', device_context: 'all', feature_keys: ['calendar'] },
      // A sibling's layout for the SAME device, so only the user filter tells them apart.
      { id: 'sibling-mobile', family_id: FAMILY_A, user_id: USER.sibling, scope: 'user', device_context: 'mobile', feature_keys: ['notes'] },
    ]);
    signedInAs(role);
    const others = structuredClone(layouts((r) => r.user_id !== USER[role] || r.family_id !== FAMILY_A));

    await expect(resetDashboardLayoutAction({ deviceContext: 'mobile' })).resolves.toEqual({ ok: true });

    expect(layouts((r) => r.user_id === USER[role] && r.family_id === FAMILY_A).map((r) => r.id)).toEqual([`mine-${role}-all`]);
    expect(layouts((r) => r.user_id !== USER[role] || r.family_id !== FAMILY_A), 'nobody else\'s layout, and no family default').toEqual(others);
    expect(events()).toEqual([expect.objectContaining({ family_id: FAMILY_A, user_id: USER[role], action: 'reset' })]);
  });

  it('ACTION-664724EB6103 a parent resetting in A does not remove their own layout in household B', async () => {
    signedInAs('parent');
    const before = familyBRows();
    await expect(resetDashboardLayoutAction()).resolves.toEqual({ ok: true });
    expect(familyBRows()).toEqual(before);
  });

  it('ACTION-664724EB6103 a signed-out caller is sent to login and nothing is removed', async () => {
    signedOut();
    const before = snapshot();
    await expect(resetDashboardLayoutAction()).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});

describe('saveFamilyDefaultLayoutAction: only a manager sets the family default', () => {
  it.each(MANAGERS)('ACTION-189AB85FF7FB %s replaces household A\'s family default and nothing else', async (role) => {
    signedInAs(role);
    const sibling = structuredClone(layouts((r) => r.id === 'lay-a-sibling'));
    const before = familyBRows();

    await expect(saveFamilyDefaultLayoutAction({ featureKeys: ['grocery', 'goals'] })).resolves.toEqual({ ok: true });

    expect(layouts((r) => r.family_id === FAMILY_A && r.scope === 'family')).toEqual([
      expect.objectContaining({ id: 'lay-a-family', user_id: null, device_context: 'all', feature_keys: ['grocery', 'goals'], updated_by: USER[role] }),
    ]);
    expect(layouts((r) => r.id === 'lay-a-sibling')).toEqual(sibling);
    expect(familyBRows()).toEqual(before);
    expect(events()).toEqual([expect.objectContaining({ family_id: FAMILY_A, user_id: USER[role], action: 'family_default_set' })]);
  });

  it.each(NON_MANAGERS)('ACTION-189AB85FF7FB %s is refused and nothing is written', async (role) => {
    signedInAs(role);
    const before = snapshot();
    await expect(saveFamilyDefaultLayoutAction({ featureKeys: ['grocery'] }))
      .resolves.toEqual({ ok: false, error: 'customizeActions.onlyAParentGuardianCan' });
    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-189AB85FF7FB a kid login is refused and nothing is written', async () => {
    signedInAsKidLogin();
    const before = snapshot();
    await expect(saveFamilyDefaultLayoutAction({ featureKeys: ['grocery'] }))
      .resolves.toEqual({ ok: false, error: 'customizeActions.onlyAParentGuardianCan' });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-189AB85FF7FB a parent may not put a feature above the plan in the family default', async () => {
    signedInAs('parent');
    const before = snapshot();
    await expect(saveFamilyDefaultLayoutAction({ featureKeys: ['command_center'] }))
      .resolves.toEqual({ ok: false, error: 'Command Center requires an upgrade.' });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-189AB85FF7FB a signed-out caller is sent to login and nothing is written', async () => {
    signedOut();
    const before = snapshot();
    await expect(saveFamilyDefaultLayoutAction({ featureKeys: ['grocery'] })).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});

describe('saveDashboardSettingsAction: only a manager sets the family\'s customization switches', () => {
  it.each(MANAGERS)('ACTION-2677F9A42D51 %s writes household A\'s settings row and nothing in B', async (role) => {
    signedInAs(role);
    const before = familyBRows();
    await expect(saveDashboardSettingsAction({ allowChildCustomization: false, lockToFamilyDefault: true })).resolves.toEqual({ ok: true });
    expect(db.table('family_dashboard_settings').filter((r) => r.family_id === FAMILY_A)).toEqual([
      expect.objectContaining({ allow_child_customization: false, lock_to_family_default: true, updated_by: USER[role] }),
    ]);
    expect(familyBRows()).toEqual(before);
    expect(events()).toEqual([expect.objectContaining({ family_id: FAMILY_A, user_id: USER[role], action: 'settings_changed' })]);
  });

  it.each(NON_MANAGERS)('ACTION-2677F9A42D51 %s cannot unlock customization and nothing is written', async (role) => {
    db.seed('family_dashboard_settings', [{ family_id: FAMILY_A, allow_child_customization: false, lock_to_family_default: true }]);
    signedInAs(role);
    const before = snapshot();
    await expect(saveDashboardSettingsAction({ allowChildCustomization: true, lockToFamilyDefault: false }))
      .resolves.toEqual({ ok: false, error: 'customizeActions.onlyAParentGuardianCan2' });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-2677F9A42D51 a kid login cannot unlock customization', async () => {
    signedInAsKidLogin();
    const before = snapshot();
    await expect(saveDashboardSettingsAction({ allowChildCustomization: true, lockToFamilyDefault: false }))
      .resolves.toEqual({ ok: false, error: 'customizeActions.onlyAParentGuardianCan2' });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-2677F9A42D51 a string "false" is refused rather than stored as true', async () => {
    signedInAs('parent');
    const before = snapshot();
    await expect(saveDashboardSettingsAction({ allowChildCustomization: 'false' as unknown as boolean, lockToFamilyDefault: false }))
      .resolves.toEqual({ ok: false, error: 'errors.thatChangeWasNotSaved' });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-2677F9A42D51 a signed-out caller is sent to login and nothing is written', async () => {
    signedOut();
    const before = snapshot();
    await expect(saveDashboardSettingsAction({ allowChildCustomization: true, lockToFamilyDefault: false })).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});

describe('resetAllLayoutsAction: only a manager resets every member\'s layout, and only in their household', () => {
  it.each(MANAGERS)('ACTION-B08ADB71B9AF %s removes every personal layout in A, keeps A\'s default and all of B', async (role) => {
    signedInAs(role);
    const before = familyBRows();
    await expect(resetAllLayoutsAction()).resolves.toEqual({ ok: true });
    expect(layouts((r) => r.family_id === FAMILY_A).map((r) => r.id)).toEqual(['lay-a-family']);
    expect(familyBRows()).toEqual(before);
    expect(events()).toEqual([expect.objectContaining({ family_id: FAMILY_A, user_id: USER[role], action: 'reset_all' })]);
  });

  it.each(NON_MANAGERS)('ACTION-B08ADB71B9AF %s is refused and every layout stays', async (role) => {
    signedInAs(role);
    const before = snapshot();
    await expect(resetAllLayoutsAction()).resolves.toEqual({ ok: false, error: 'customizeActions.onlyAParentGuardianCan3' });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-B08ADB71B9AF a kid login is refused and every layout stays', async () => {
    signedInAsKidLogin();
    const before = snapshot();
    await expect(resetAllLayoutsAction()).resolves.toEqual({ ok: false, error: 'customizeActions.onlyAParentGuardianCan3' });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-B08ADB71B9AF a signed-out caller is sent to login and every layout stays', async () => {
    signedOut();
    const before = snapshot();
    await expect(resetAllLayoutsAction()).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});

describe('logDashboardEventAction: any member logs their own event in their own household', () => {
  it.each(ROLES)('ACTION-C8833C3BA0D1 %s logs one first-person event in household A', async (role) => {
    signedInAs(role);
    const before = familyBRows();
    await expect(logDashboardEventAction({ action: 'locked_click', featureKey: 'command_center' })).resolves.toEqual({ ok: true });
    expect(events()).toEqual([expect.objectContaining({ family_id: FAMILY_A, user_id: USER[role], action: 'locked_click', feature_key: 'command_center' })]);
    expect(familyBRows()).toEqual(before);
    expect(db.table('dashboard_layouts')).toHaveLength(5);
  });

  it('ACTION-C8833C3BA0D1 a member of B logs into B, never into A', async () => {
    signedInAs('child', { family: FAMILY_B, user: USER.other });
    await expect(logDashboardEventAction({ action: 'upgrade_cta' })).resolves.toEqual({ ok: true });
    expect(events()).toEqual([expect.objectContaining({ family_id: FAMILY_B, user_id: USER.other, feature_key: null })]);
  });

  it('ACTION-C8833C3BA0D1 a signed-out caller gets ok:false and nothing is logged', async () => {
    signedOut();
    await expect(logDashboardEventAction({ action: 'upgrade_cta' })).resolves.toEqual({ ok: false });
    expect(events()).toEqual([]);
  });
});
