// A PIN reset touches only an account that is a kid login.
//
// resetChildPinAction checks that the member is in the caller's family, is not
// a manager, and that the member row and the child_logins row name the same
// user (tests/a-pin-reset-cannot-reach-a-parents-account.test.ts). None of that
// says the account IS a kid login. A household's parent can write child_logins
// (0297) for any member who is not a manager and has their own account, such
// as a caregiver, a guest, or a teen who signed up with their own email. The
// reset then replaced that person's real password with one derived from a PIN,
// locking them out of their own account; the PIN sign-in itself only ever
// reaches the synthetic address, so it did not even give the parent a working
// login, just a broken one for the adult.
//
// The provenance the action now requires is the account's address as the auth
// server reports it: exactly syntheticChildEmail(username), which only
// createChildLoginAction creates (service role) and no household can write.
// These call the real action and assert which user's password is set and
// whether the sign-in lockout is touched, because nothing may change before the
// refusal.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PARENT_USER = '22222222-2222-4222-8222-222222222222';
const MEMBER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARENT_MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type Row = Record<string, unknown> | null;
const state = vi.hoisted(() => ({
  childLogin: null as Row,
  member: null as Row,
  account: null as { email: string | null } | null,
  accountError: null as { message: string } | null,
  passwordSetFor: [] as string[],
  updatedTables: [] as string[],
}));

function fakeAdmin() {
  const table = (name: string) => {
    const chain: Record<string, unknown> = {};
    const resolve = () => Promise.resolve({
      data: name === 'child_logins' ? state.childLogin : name === 'family_members' ? state.member : null,
      error: null,
    });
    for (const method of ['select', 'eq', 'insert', 'upsert', 'delete']) chain[method] = () => chain;
    chain.update = () => { state.updatedTables.push(name); return chain; };
    chain.maybeSingle = resolve;
    chain.single = resolve;
    chain.then = (...args: unknown[]) => (resolve() as PromiseLike<unknown>).then(...(args as [never, never]));
    return chain;
  };
  return {
    from: (name: string) => table(name),
    auth: {
      admin: {
        getUserById: async (userId: string) => ({
          data: state.account ? { user: { id: userId, email: state.account.email } } : { user: null },
          error: state.accountError,
        }),
        updateUserById: async (userId: string) => {
          state.passwordSetFor.push(userId);
          return { data: null, error: null };
        },
      },
    },
  };
}

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: PARENT_USER },
    active: { familyId: FAMILY, member: { id: PARENT_MEMBER }, role: 'parent' },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => fakeAdmin() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));

process.env.CHILD_LOGIN_SECRET = 'test-secret-for-derivation';

const { resetChildPinAction } = await import('@/app/(app)/family/child-login-actions');

/** A member of the caller's family whose row and mapping agree, as a parent's
 *  own child_logins write would make them agree. */
function mapped(role: string, email: string | null, extra: Record<string, unknown> = {}) {
  state.childLogin = { user_id: ACCOUNT, username: 'jordan', family_id: FAMILY };
  state.member = { id: MEMBER, family_id: FAMILY, role, user_id: ACCOUNT, is_active: true, ...extra };
  state.account = { email };
}

beforeEach(() => {
  state.accountError = null;
  state.passwordSetFor = [];
  state.updatedTables = [];
});

describe('a PIN reset proceeds only for the kid login the username names', () => {
  // The positive controls first: a genuine kid login, held by any role
  // createChildLoginAction serves, still resets.
  it.each(['child', 'teen', 'caregiver', 'guest'])('resets a genuine kid login held by a %s', async (role) => {
    mapped(role, 'child.jordan@kids.bubaly.app');
    const result = await resetChildPinAction({ memberId: MEMBER, pin: '1234' });
    expect(result).toEqual({ ok: true });
    expect(state.passwordSetFor).toEqual([ACCOUNT]);
    expect(state.updatedTables).toContain('child_login_throttle');
  });

  it('reads the address in any case, as the auth server may return it', async () => {
    mapped('child', 'Child.Jordan@Kids.Bubaly.App');
    const result = await resetChildPinAction({ memberId: MEMBER, pin: '1234' });
    expect(result).toEqual({ ok: true });
    expect(state.passwordSetFor).toEqual([ACCOUNT]);
  });

  it.each([
    ['caregiver', 'sitter@example.com'],
    ['guest', 'grandma@example.com'],
    ['teen', 'teen.own.account@example.com'],
  ])('refuses a %s whose own account a parent mapped, before anything changes', async (role, email) => {
    mapped(role, email);
    const result = await resetChildPinAction({ memberId: MEMBER, pin: '1234' });
    // The account first: against the pre-fix action this names the adult whose
    // real password was replaced, which is the defect.
    expect(state.passwordSetFor).toEqual([]);
    expect(state.updatedTables).toEqual([]);
    expect(result).toEqual({ ok: false, error: 'childLoginActions.couldNotResetThePin' });
  });

  it('refuses an ordinary account behind an inactive mapping too', async () => {
    mapped('caregiver', 'former.sitter@example.com', { is_active: false });
    const result = await resetChildPinAction({ memberId: MEMBER, pin: '1234' });
    expect(state.passwordSetFor).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('refuses another kid login mapped under this username', async () => {
    // A synthetic address is not enough: it has to be THIS username's, or the
    // reset sets another child's password to one derived from this username.
    mapped('child', 'child.sibling@kids.bubaly.app');
    const result = await resetChildPinAction({ memberId: MEMBER, pin: '1234' });
    expect(state.passwordSetFor).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('refuses when the account has no address', async () => {
    mapped('child', null);
    const result = await resetChildPinAction({ memberId: MEMBER, pin: '1234' });
    expect(state.passwordSetFor).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('refuses, changing nothing, when the account cannot be read', async () => {
    mapped('child', 'child.jordan@kids.bubaly.app');
    state.accountError = { message: 'auth server unavailable' };
    const result = await resetChildPinAction({ memberId: MEMBER, pin: '1234' });
    expect(state.passwordSetFor).toEqual([]);
    expect(state.updatedTables).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('refuses, changing nothing, when the auth server knows no such account', async () => {
    mapped('child', 'child.jordan@kids.bubaly.app');
    state.account = null;
    const result = await resetChildPinAction({ memberId: MEMBER, pin: '1234' });
    expect(state.passwordSetFor).toEqual([]);
    expect(result.ok).toBe(false);
  });
});
