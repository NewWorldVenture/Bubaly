// Whose password a PIN reset sets is decided by `family_members`, not by a table
// every member can write.
//
// `child_logins`' write policy is named "Managers manage child_logins" and
// predicated on `is_family_member(family_id)` (supabase/migrations/01051, line
// 44) — so every member of the household, a child included, can UPDATE it.
// `resetChildPinAction` is manager-gated, but it read `row.user_id` straight out
// of that table and handed it to `admin.auth.admin.updateUserById` under the
// SERVICE ROLE.
//
// The chain: a child points their own row's `user_id` at a PARENT's auth user,
// then asks that parent to reset their PIN — "I forgot it", an ordinary request.
// The reset sets the PARENT's account password to
// `deriveChildPassword(secret, childUsername, pin)`. Child to parent account
// takeover, with the parent's own hand on the button, and nothing in the audit
// log to distinguish it from a normal reset.
//
// Migration 0299 closes the write hole, but production's ledger is gated (F-001),
// so the application must close the takeover on its own — which is what these
// exercise. They call the real action and assert WHICH user id reaches
// updateUserById, because "the source destructures the member row" is not the
// claim; "the parent's password is never set" is.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CHILD_USER = '11111111-1111-4111-8111-111111111111';
const PARENT_USER = '22222222-2222-4222-8222-222222222222';
const CHILD_MEMBER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARENT_MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type Row = Record<string, unknown> | null;
const state = vi.hoisted(() => ({
  childLogin: null as Row,
  member: null as Row,
  passwordSetFor: [] as string[],
}));

/** A service client whose two reads are configurable and whose write is observed. */
function fakeAdmin() {
  const table = (name: string) => {
    const chain: Record<string, unknown> = {};
    const resolve = () => Promise.resolve({
      data: name === 'child_logins' ? state.childLogin : name === 'family_members' ? state.member : null,
      error: null,
    });
    for (const method of ['select', 'eq', 'update', 'insert', 'upsert', 'delete']) chain[method] = () => chain;
    chain.maybeSingle = resolve;
    chain.single = resolve;
    chain.limit = () => Promise.resolve({ data: [], error: null });
    chain.then = (...args: unknown[]) => (resolve() as PromiseLike<unknown>).then(...(args as [never, never]));
    return chain;
  };
  return {
    from: (name: string) => table(name),
    auth: {
      admin: {
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

const childLoginRow = (over: Record<string, unknown> = {}) => ({
  user_id: CHILD_USER, username: 'jordan', family_id: FAMILY, ...over,
});
const memberRow = (over: Record<string, unknown> = {}) => ({
  id: CHILD_MEMBER, family_id: FAMILY, role: 'child', user_id: CHILD_USER, ...over,
});

beforeEach(() => {
  state.childLogin = childLoginRow();
  state.member = memberRow();
  state.passwordSetFor = [];
});

describe('a PIN reset only ever sets the password of the member it names', () => {
  // The negative control, first: a real reset has to keep working, or every
  // assertion below is satisfied by an action that does nothing.
  it('resets the child whose member row and login row agree', async () => {
    const result = await resetChildPinAction({ memberId: CHILD_MEMBER, pin: '1234' });
    expect(result).toEqual({ ok: true });
    expect(state.passwordSetFor).toEqual([CHILD_USER]);
  });

  it('refuses when child_logins.user_id points at someone else', async () => {
    state.childLogin = childLoginRow({ user_id: PARENT_USER });
    const result = await resetChildPinAction({ memberId: CHILD_MEMBER, pin: '1234' });
    // This assertion FIRST, deliberately: against the pre-fix action it reports
    // `[ '2222…' ]` — the parent's auth user id — which is the takeover itself,
    // and naming it in the failure is worth more than "expected true to be false".
    expect(state.passwordSetFor).toEqual([]);
    expect(result.ok).toBe(false);
  });

  // The other spelling of the same tamper: leave `user_id` alone and move
  // `member_id` onto a parent, who then has a "child login" the create action
  // would never have made (it refuses a member who already has a `user_id`).
  it('refuses when the named member is a manager', async () => {
    state.childLogin = childLoginRow({ user_id: PARENT_USER });
    state.member = memberRow({ id: PARENT_MEMBER, role: 'parent', user_id: PARENT_USER });
    const result = await resetChildPinAction({ memberId: PARENT_MEMBER, pin: '1234' });
    expect(result.ok).toBe(false);
    expect(state.passwordSetFor).toEqual([]);
  });

  it('refuses a manager even when the two rows agree perfectly', async () => {
    // A consistent mapping is not authorisation. `adult` is a manager role too.
    state.childLogin = childLoginRow({ user_id: PARENT_USER });
    state.member = memberRow({ id: PARENT_MEMBER, role: 'adult', user_id: PARENT_USER });
    const result = await resetChildPinAction({ memberId: PARENT_MEMBER, pin: '1234' });
    expect(result.ok).toBe(false);
    expect(state.passwordSetFor).toEqual([]);
  });

  it('refuses when the member belongs to another family', async () => {
    state.member = memberRow({ family_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    const result = await resetChildPinAction({ memberId: CHILD_MEMBER, pin: '1234' });
    expect(result.ok).toBe(false);
    expect(state.passwordSetFor).toEqual([]);
  });

  it('refuses when the member has no auth user to reset', async () => {
    state.member = memberRow({ user_id: null });
    const result = await resetChildPinAction({ memberId: CHILD_MEMBER, pin: '1234' });
    expect(result.ok).toBe(false);
    expect(state.passwordSetFor).toEqual([]);
  });

  it('refuses when the member row is missing entirely', async () => {
    state.member = null;
    const result = await resetChildPinAction({ memberId: CHILD_MEMBER, pin: '1234' });
    expect(result.ok).toBe(false);
    expect(state.passwordSetFor).toEqual([]);
  });

  // Teens and caregivers legitimately get logins — `createChildLoginAction`
  // restricts by "has no user_id yet", not by role — so the manager check must
  // not have quietly narrowed that to role === 'child'.
  it.each(['teen', 'caregiver', 'guest'])('still resets a %s login', async (role) => {
    state.member = memberRow({ role });
    const result = await resetChildPinAction({ memberId: CHILD_MEMBER, pin: '1234' });
    expect(result).toEqual({ ok: true });
    expect(state.passwordSetFor).toEqual([CHILD_USER]);
  });
});
