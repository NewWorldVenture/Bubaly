// Two child logins created for one member at the same moment leave ONE login,
// and it is the one that signs in.
//
// `createChildLoginAction` refused a member that already had a `user_id` — but
// read that from a row it then linked with a write keyed on the member's id
// alone. Two parents setting up the same child together (or one parent who
// changed the username and pressed Create again before the first answered)
// both read `user_id: null`, both created an auth user, and both linked —
// the second overwriting the first. `child_logins.member_id` is unique, so the
// loser's insert failed and its rollback ran `update({ user_id: null })` on the
// member: it unlinked the WINNER. What was left was a `child_logins` row whose
// username signs in to an auth user that resolves to no member at all, a member
// with no `user_id` that every later Create trips over on that unique index,
// and a PIN reset that answers "login not found". No screen can undo it.
//
// The link is now a compare-and-set on `user_id is null`, and a rollback only
// ever unlinks the user it linked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { readsLandTogether } from './helpers/reads-land-together';

const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CHILD_MEMBER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARENT_MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARENT_USER = '22222222-2222-4222-8222-222222222222';

type Admin = InMemorySupabase & {
  auth: InMemorySupabase['auth'] & { admin: Record<string, (...args: never[]) => Promise<unknown>> };
};

const state = vi.hoisted(() => ({ db: null as unknown as Admin, users: new Map<string, string>(), seq: 0 }));

function fakeAdmin(): Admin {
  const db = createInMemorySupabase({
    uniques: { child_logins: [['member_id'], ['user_id'], ['username']], user_preferences: [['user_id']] },
  }) as Admin;
  const auth = db.auth as Admin['auth'];
  auth.admin = {
    createUser: async ({ email }: { email: string }) => {
      if ([...state.users.values()].includes(email)) return { data: null, error: { message: 'email exists' } };
      const id = `00000000-0000-4000-8000-${String(++state.seq).padStart(12, '0')}`;
      state.users.set(id, email);
      return { data: { user: { id } }, error: null };
    },
    deleteUser: async (id: string) => { state.users.delete(id); return { data: null, error: null }; },
    updateUserById: async () => ({ data: null, error: null }),
  };
  return db;
}

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: PARENT_USER },
    active: { familyId: FAMILY, member: { id: PARENT_MEMBER }, role: 'parent' },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));

process.env.CHILD_LOGIN_SECRET = 'test-secret-for-derivation';

const { createChildLoginAction } = await import('@/app/(app)/family/child-login-actions');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.users = new Map();
  state.seq = 0;
  state.db = fakeAdmin();
  state.db.seed('family_members', [
    { id: CHILD_MEMBER, family_id: FAMILY, display_name: 'Jordan', role: 'child', user_id: null, is_active: true },
  ]);
});

describe('two logins made for one child at once leave one that works', () => {
  it('the member stays linked to the auth user its login row names', async () => {
    readsLandTogether(state.db, 'family_members', 2);

    const results = await Promise.all([
      createChildLoginAction({ memberId: CHILD_MEMBER, username: 'jordan', pin: '4821' }),
      createChildLoginAction({ memberId: CHILD_MEMBER, username: 'jordan2', pin: '4821' }),
    ]);

    expect(results.filter((r) => r.ok), 'exactly one of the two creates should win').toHaveLength(1);

    const member = state.db.table('family_members').find((m) => m.id === CHILD_MEMBER)!;
    const logins = state.db.table('child_logins');
    expect(logins).toHaveLength(1);
    expect(member.user_id, 'the losing create unlinked the login that won').toBe(logins[0].user_id);
    // The winner's auth user is the only one left; the loser's was given back.
    expect([...state.users.keys()]).toEqual([logins[0].user_id]);
  });

  it('a single create still links the member and records the login', async () => {
    const result = await createChildLoginAction({ memberId: CHILD_MEMBER, username: 'jordan', pin: '4821' });
    expect(result).toMatchObject({ ok: true, data: { username: 'jordan' } });
    const member = state.db.table('family_members').find((m) => m.id === CHILD_MEMBER)!;
    expect(state.db.table('child_logins')).toEqual([expect.objectContaining({ member_id: CHILD_MEMBER, user_id: member.user_id, username: 'jordan' })]);
  });
});
