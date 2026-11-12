// Call-level role tests for the two kid-login actions in
// app/(app)/family/child-login-actions.ts (Register B group 6).
//
// THE POLICY, from the sources rather than from the action:
//   - lib/constants/roles.ts: isManager = parent or adult.
//   - app/(app)/dashboard/family-access/page.tsx:23 redirects anyone who is not
//     a manager; lib/constants/navigation.ts:183 marks "Kid Logins" `manage`.
//   - supabase/migrations/0297_sensitive_tables_respect_role.sql:69-72 is the
//     live write policy on child_logins: can_manage_family(family_id).
//   - The action's own docstrings: "Manager only."
// So a parent or adult of the member's own family may make or reset a kid login;
// a teen, child, caregiver, guest, a kid login itself and a signed-out caller may
// not, and nobody may reach a member of another household.
//
// The REAL actions run against the in-memory PostgREST fake as the service
// client. The only things stubbed are the session (requireUserContext), the
// translator (keys are returned as-is) and the auth admin API, which this
// repository has no fake for: a small one below keeps real accounts in a table
// so a created user and a changed password can be read back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { syntheticChildEmail } from '@/lib/onboarding/child-login';
import { deriveChildPassword } from '@/lib/onboarding/child-password';

const SECRET = 'a-test-only-child-login-secret';

const FAMILY_A = '0a000000-0000-4000-8000-00000000000a';
const FAMILY_B = '0b000000-0000-4000-8000-00000000000b';

// Household A: one member per role, each with their own account, plus a child
// with no login yet (for create) and a child who already has one (for reset).
const ROLE_MEMBERS = {
  parent: { member: 'a1000000-0000-4000-8000-000000000001', user: 'e1000000-0000-4000-8000-000000000001' },
  adult: { member: 'a1000000-0000-4000-8000-000000000002', user: 'e1000000-0000-4000-8000-000000000002' },
  teen: { member: 'a1000000-0000-4000-8000-000000000003', user: 'e1000000-0000-4000-8000-000000000003' },
  child: { member: 'a1000000-0000-4000-8000-000000000004', user: 'e1000000-0000-4000-8000-000000000004' },
  caregiver: { member: 'a1000000-0000-4000-8000-000000000005', user: 'e1000000-0000-4000-8000-000000000005' },
  guest: { member: 'a1000000-0000-4000-8000-000000000006', user: 'e1000000-0000-4000-8000-000000000006' },
} as const;
type Role = keyof typeof ROLE_MEMBERS;

const A_NEW_CHILD = 'a2000000-0000-4000-8000-000000000001';
const A_KID = 'a2000000-0000-4000-8000-000000000002';
const A_KID_USER = 'e2000000-0000-4000-8000-000000000002';
const A_KID_NAME = 'robin';
const A_KID_OLD_PASSWORD = 'robin-old-password';

const B_NEW_CHILD = 'b2000000-0000-4000-8000-000000000001';
const B_KID = 'b2000000-0000-4000-8000-000000000002';
const B_KID_USER = 'e3000000-0000-4000-8000-000000000002';
const B_KID_NAME = 'skye';
const B_KID_OLD_PASSWORD = 'skye-old-password';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  admin: null as unknown,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mocks.admin }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { createChildLoginAction, resetChildPinAction } = await import('@/app/(app)/family/child-login-actions');

let db: InMemorySupabase;

/** The auth admin API over an `auth_users` table, so its effects can be read back. */
function withAuthAdmin(client: InMemorySupabase) {
  const users = () => client.table('auth_users');
  Object.assign(client.auth, {
    admin: {
      createUser: async (attrs: { email: string; password: string; app_metadata?: Row; user_metadata?: Row }) => {
        if (users().some((u) => u.email === attrs.email)) return { data: { user: null }, error: { message: 'exists' } };
        const id = `e9000000-0000-4000-8000-${String(users().length).padStart(12, '0')}`;
        client.seed('auth_users', [{ id, email: attrs.email, password: attrs.password, app_metadata: attrs.app_metadata ?? {} }]);
        return { data: { user: { id, email: attrs.email } }, error: null };
      },
      getUserById: async (id: string) => {
        const user = users().find((u) => u.id === id);
        return user ? { data: { user: { id, email: user.email } }, error: null } : { data: { user: null }, error: { message: 'not found' } };
      },
      updateUserById: async (id: string, patch: { password?: string }) => {
        const user = users().find((u) => u.id === id);
        if (!user) return { data: { user: null }, error: { message: 'not found' } };
        Object.assign(user, patch);
        return { data: { user: { id } }, error: null };
      },
      deleteUser: async (id: string) => {
        db.replace('auth_users', users().filter((u) => u.id !== id));
        return { data: null, error: null };
      },
    },
  });
  return client;
}

function seedHouseholds() {
  db.seed('family_members', [
    ...(Object.entries(ROLE_MEMBERS) as [Role, { member: string; user: string }][]).map(([role, ids]) => ({
      id: ids.member, family_id: FAMILY_A, role, user_id: ids.user, is_active: true, display_name: role,
    })),
    { id: A_NEW_CHILD, family_id: FAMILY_A, role: 'child', user_id: null, is_active: true, display_name: 'Ash' },
    { id: A_KID, family_id: FAMILY_A, role: 'child', user_id: A_KID_USER, is_active: true, display_name: 'Robin' },
    { id: B_NEW_CHILD, family_id: FAMILY_B, role: 'child', user_id: null, is_active: true, display_name: 'Bay' },
    { id: B_KID, family_id: FAMILY_B, role: 'child', user_id: B_KID_USER, is_active: true, display_name: 'Skye' },
  ]);
  db.seed('child_logins', [
    { id: 'c1000000-0000-4000-8000-000000000001', family_id: FAMILY_A, member_id: A_KID, user_id: A_KID_USER, username: A_KID_NAME },
    { id: 'c1000000-0000-4000-8000-000000000002', family_id: FAMILY_B, member_id: B_KID, user_id: B_KID_USER, username: B_KID_NAME },
  ]);
  db.seed('auth_users', [
    { id: A_KID_USER, email: syntheticChildEmail(A_KID_NAME), password: A_KID_OLD_PASSWORD },
    { id: B_KID_USER, email: syntheticChildEmail(B_KID_NAME), password: B_KID_OLD_PASSWORD },
  ]);
  db.seed('child_login_throttle', [
    { id: 'd1000000-0000-4000-8000-000000000001', username: A_KID_NAME, fails: 5, locked_until: '2099-01-01T00:00:00.000Z', window_start: '2026-01-01T00:00:00.000Z' },
    { id: 'd1000000-0000-4000-8000-000000000002', username: B_KID_NAME, fails: 5, locked_until: '2099-01-01T00:00:00.000Z', window_start: '2026-01-01T00:00:00.000Z' },
  ]);
}

const signedInAs = (role: Role) => mocks.requireUserContext.mockResolvedValue({
  user: { id: ROLE_MEMBERS[role].user },
  active: { familyId: FAMILY_A, role, member: { id: ROLE_MEMBERS[role].member }, family: { name: 'Household A', timezone: 'UTC' } },
});

/** Every table either action can write, as a snapshot to compare with afterwards. */
const snapshot = () => JSON.stringify(
  ['family_members', 'child_logins', 'auth_users', 'child_login_throttle', 'user_preferences', 'audit_logs']
    .map((name) => [name, db.table(name)]),
);
const member = (id: string) => db.table('family_members').find((row) => row.id === id)!;
const account = (id: string) => db.table('auth_users').find((row) => row.id === id)!;
const throttle = (username: string) => db.table('child_login_throttle').find((row) => row.username === username)!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.CHILD_LOGIN_SECRET = SECRET;
  db = withAuthAdmin(createInMemorySupabase());
  mocks.admin = db;
  seedHouseholds();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CHILD_LOGIN_SECRET;
});

const MANAGERS = ['parent', 'adult'] as const;
const NOT_MANAGERS = ['teen', 'child', 'caregiver', 'guest'] as const;

describe('createChildLoginAction', () => {
  it.each(MANAGERS)('ACTION-C2C30832A31E: a %s gives their own child a login, and every row it promises lands', async (role) => {
    signedInAs(role);
    const result = await createChildLoginAction({ memberId: A_NEW_CHILD, username: 'Ash_1', pin: '4821' });

    expect(result).toEqual({ ok: true, data: { username: 'ash_1' } });
    const created = db.table('auth_users').filter((row) => row.email === syntheticChildEmail('ash_1'));
    expect(created).toHaveLength(1);
    const childUser = created[0].id;
    expect(created[0]).toMatchObject({
      password: deriveChildPassword(SECRET, 'ash_1', '4821'),
      app_metadata: { bubaly_kid_login: true },
    });
    expect(member(A_NEW_CHILD)).toMatchObject({ user_id: childUser, is_active: true, family_id: FAMILY_A });
    expect(db.table('child_logins').filter((row) => row.member_id === A_NEW_CHILD)).toEqual([
      expect.objectContaining({ family_id: FAMILY_A, user_id: childUser, username: 'ash_1', created_by: ROLE_MEMBERS[role].user }),
    ]);
    expect(db.table('user_preferences')).toEqual([expect.objectContaining({ user_id: childUser, active_family_id: FAMILY_A })]);
    expect(db.table('audit_logs')).toEqual([expect.objectContaining({ family_id: FAMILY_A, resource: 'child_logins' })]);
  });

  it.each(NOT_MANAGERS)('ACTION-C2C30832A31E: a %s is refused and nothing is written', async (role) => {
    signedInAs(role);
    const before = snapshot();
    const result = await createChildLoginAction({ memberId: A_NEW_CHILD, username: 'ash_1', pin: '4821' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.onlyAParentOrGuardian' });
    expect(snapshot()).toBe(before);
    expect(member(A_NEW_CHILD).user_id).toBeNull();
  });

  it('ACTION-C2C30832A31E: a kid login (a child signed in on their PIN account) cannot mint another login', async () => {
    mocks.requireUserContext.mockResolvedValue({
      user: { id: A_KID_USER },
      active: { familyId: FAMILY_A, role: 'child', member: { id: A_KID }, family: { name: 'Household A', timezone: 'UTC' } },
    });
    const before = snapshot();
    const result = await createChildLoginAction({ memberId: A_NEW_CHILD, username: 'ash_1', pin: '4821' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.onlyAParentOrGuardian' });
    expect(snapshot()).toBe(before);
  });

  it('ACTION-C2C30832A31E: a signed-out caller is sent away before anything is read or written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
    const before = snapshot();
    await expect(createChildLoginAction({ memberId: A_NEW_CHILD, username: 'ash_1', pin: '4821' })).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toBe(before);
    expect(db.log).toEqual([]);
  });

  it.each(MANAGERS)('ACTION-C2C30832A31E: a %s naming a child of another household gets "not found" and neither household changes', async (role) => {
    signedInAs(role);
    const before = snapshot();
    const result = await createChildLoginAction({ memberId: B_NEW_CHILD, username: 'bay_1', pin: '4821' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.memberNotFoundInYour' });
    expect(snapshot()).toBe(before);
    expect(member(B_NEW_CHILD).user_id).toBeNull();
  });

  it('ACTION-C2C30832A31E: a parent cannot put a PIN login on a manager of their own household', async () => {
    db.seed('family_members', [{ id: 'a3000000-0000-4000-8000-000000000001', family_id: FAMILY_A, role: 'adult', user_id: null, is_active: true, display_name: 'Gran' }]);
    // A stale lockout on the handle: refused BEFORE anything is created, the
    // create path does not even reach the throttle clear (nor mint an account
    // and roll it back, which the link's role filter would otherwise catch).
    db.seed('child_login_throttle', [{ id: 'd1000000-0000-4000-8000-000000000003', username: 'gran_1', fails: 5, locked_until: '2099-01-01T00:00:00.000Z', window_start: '2026-01-01T00:00:00.000Z' }]);
    signedInAs('parent');
    const before = snapshot();
    const result = await createChildLoginAction({ memberId: 'a3000000-0000-4000-8000-000000000001', username: 'gran_1', pin: '4821' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.aParentOrAdultSignsIn' });
    expect(snapshot()).toBe(before);
  });
});

describe('resetChildPinAction', () => {
  it.each(MANAGERS)('ACTION-25A37296236E: a %s resets their own child\'s PIN and lifts the lockout', async (role) => {
    signedInAs(role);
    const result = await resetChildPinAction({ memberId: A_KID, pin: '7310' });

    expect(result).toEqual({ ok: true });
    expect(account(A_KID_USER).password).toBe(deriveChildPassword(SECRET, A_KID_NAME, '7310'));
    expect(throttle(A_KID_NAME)).toMatchObject({ fails: 0, locked_until: null });
    expect(account(B_KID_USER).password).toBe(B_KID_OLD_PASSWORD);
    expect(throttle(B_KID_NAME)).toMatchObject({ fails: 5 });
    expect(db.table('audit_logs')).toEqual([expect.objectContaining({ family_id: FAMILY_A, resource: 'child_logins' })]);
  });

  it.each(NOT_MANAGERS)('ACTION-25A37296236E: a %s is refused and no password or lockout changes', async (role) => {
    signedInAs(role);
    const before = snapshot();
    const result = await resetChildPinAction({ memberId: A_KID, pin: '7310' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.onlyAParentOrGuardian2' });
    expect(snapshot()).toBe(before);
    expect(account(A_KID_USER).password).toBe(A_KID_OLD_PASSWORD);
  });

  it('ACTION-25A37296236E: a kid login cannot reset its own PIN', async () => {
    mocks.requireUserContext.mockResolvedValue({
      user: { id: A_KID_USER },
      active: { familyId: FAMILY_A, role: 'child', member: { id: A_KID }, family: { name: 'Household A', timezone: 'UTC' } },
    });
    const before = snapshot();
    const result = await resetChildPinAction({ memberId: A_KID, pin: '7310' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.onlyAParentOrGuardian2' });
    expect(snapshot()).toBe(before);
  });

  it('ACTION-25A37296236E: a signed-out caller is sent away before anything is read or written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
    const before = snapshot();
    await expect(resetChildPinAction({ memberId: A_KID, pin: '7310' })).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toBe(before);
    expect(db.log).toEqual([]);
  });

  it.each(MANAGERS)('ACTION-25A37296236E: a %s naming a kid of another household gets "not found" and that kid keeps their PIN', async (role) => {
    signedInAs(role);
    const before = snapshot();
    const result = await resetChildPinAction({ memberId: B_KID, pin: '7310' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.loginNotFound' });
    expect(snapshot()).toBe(before);
    expect(account(B_KID_USER).password).toBe(B_KID_OLD_PASSWORD);
    expect(throttle(B_KID_NAME)).toMatchObject({ fails: 5 });
  });

  it('ACTION-25A37296236E: a mapping moved into household A that still points at B\'s member is refused', async () => {
    // The login row says A, the member row says B: the member side decides.
    db.table('child_logins').find((row) => row.member_id === B_KID)!.family_id = FAMILY_A;
    signedInAs('parent');
    const before = snapshot();
    const result = await resetChildPinAction({ memberId: B_KID, pin: '7310' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.loginNotFound' });
    expect(snapshot()).toBe(before);
    expect(account(B_KID_USER).password).toBe(B_KID_OLD_PASSWORD);
  });

  it('ACTION-25A37296236E: a login row filed under another household is not this household\'s to reset', async () => {
    // The member row says A, the login row says B: a reset reaches only a login A holds.
    db.table('child_logins').find((row) => row.member_id === A_KID)!.family_id = FAMILY_B;
    signedInAs('parent');
    const before = snapshot();
    const result = await resetChildPinAction({ memberId: A_KID, pin: '7310' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.loginNotFound' });
    expect(snapshot()).toBe(before);
    expect(account(A_KID_USER).password).toBe(A_KID_OLD_PASSWORD);
  });
});
