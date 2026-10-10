import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// createChildLoginAction, against the real action:
//
// * It never checked the TARGET's role, so a manager could put a username +
//   4-digit PIN login on an unlinked 'parent' or 'adult' member row: a full
//   manager account behind a PIN its creator knows, which resetChildPinAction
//   then refuses to ever reset.
// * The link `update({ user_id })` had no `user_id IS NULL` compare-and-set,
//   and the rollback's unlink had no `user_id = <this attempt>` guard. Two
//   concurrent creates both passed the "already has a login" read; the second
//   overwrote the first's link, failed on unique(member_id), and its rollback
//   cleared user_id — orphaning the first login for good.
//
// And ensureActiveFamily: a removed child login (no active membership) was
// auto-provisioned a brand-new family with the child as its parent.

const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PARENT_USER = '22222222-2222-4222-8222-222222222222';
const state = vi.hoisted(() => ({ db: null as unknown, created: [] as string[], deleted: [] as string[], next: 0 }));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: '22222222-2222-4222-8222-222222222222' },
    active: { familyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', member: { id: 'parent-member' }, role: 'parent' } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));

process.env.CHILD_LOGIN_SECRET = 'test-secret-for-derivation';
const { createChildLoginAction } = await import('@/app/(app)/family/child-login-actions');
const { ensureActiveFamily } = await import('@/lib/server/ensure-family');

let db: InMemorySupabase;
function build(rpc: Record<string, (args: Record<string, unknown>, db: InMemorySupabase) => unknown> = {}) {
  db = createInMemorySupabase({ uniques: { child_logins: [['member_id'], ['username']] }, rpc });
  Object.assign(db.auth, { admin: {
    createUser: async () => { const id = `child-user-${++state.next}`; state.created.push(id); return { data: { user: { id } }, error: null }; },
    deleteUser: async (id: string) => { state.deleted.push(id); return { error: null }; },
  } });
  state.db = db;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.created = []; state.deleted = []; state.next = 0;
  build();
});

describe('createChildLoginAction', () => {
  it.each(['parent', 'adult'])('refuses a PIN login for a %s member, creating nothing', async (role) => {
    db.seed('family_members', [{ id: 'm', family_id: FAMILY, display_name: 'Pat', user_id: null, role, is_active: true }]);
    const result = await createChildLoginAction({ memberId: 'm', username: 'patpat', pin: '1234' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.onlyForAMemberWhoIsNot' });
    expect(state.created).toEqual([]);
    expect(db.table('family_members')[0].user_id).toBeNull();
  });

  it('creates one for a child (control)', async () => {
    db.seed('family_members', [{ id: 'm', family_id: FAMILY, display_name: 'Emma', user_id: null, role: 'child', is_active: true }]);
    expect(await createChildLoginAction({ memberId: 'm', username: 'emma', pin: '1234' })).toMatchObject({ ok: true });
    expect(db.table('family_members')[0].user_id).toBe('child-user-1');
    expect(db.table('child_logins')).toHaveLength(1);
  });

  it('does not overwrite a link another attempt made in the meantime', async () => {
    db.seed('family_members', [{ id: 'm', family_id: FAMILY, display_name: 'Emma', user_id: null, role: 'child', is_active: true }]);
    // Attempt A links between B's read and B's link: simulate by linking the
    // row the moment B's auth user is created.
    const admin = db.auth as unknown as { admin: { createUser: () => Promise<unknown> } };
    const real = admin.admin.createUser;
    admin.admin.createUser = async () => {
      const out = await real();
      db.table('family_members')[0].user_id = 'attempt-a-user';
      db.seed('child_logins', [{ family_id: FAMILY, member_id: 'm', user_id: 'attempt-a-user', username: 'emma1' }]);
      return out;
    };
    const result = await createChildLoginAction({ memberId: 'm', username: 'emma2', pin: '1234' });
    expect(result).toEqual({ ok: false, error: 'childLoginActions.thisMemberAlreadyHasA' });
    // A's login is intact and still linked; B's orphan auth user is removed.
    expect(db.table('family_members')[0].user_id).toBe('attempt-a-user');
    expect(db.table('child_logins').map((r) => r.user_id)).toEqual(['attempt-a-user']);
    expect(state.deleted).toEqual(['child-user-1']);
  });

  it("a failed save's rollback unlinks only its own login", async () => {
    db.seed('family_members', [{ id: 'm', family_id: FAMILY, display_name: 'Emma', user_id: null, role: 'child', is_active: true }]);
    // B's link succeeds, then A's link lands and A's child_logins row takes
    // unique(member_id), so B's insert fails and B rolls back.
    db.seed('child_logins', [{ family_id: FAMILY, member_id: 'm', user_id: 'attempt-a-user', username: 'emma1' }]);
    const original = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table: string) => {
      const q = original(table);
      if (table === 'child_logins') {
        const insert = q.insert.bind(q);
        vi.spyOn(q, 'insert').mockImplementation((rows) => { db.table('family_members')[0].user_id = 'attempt-a-user'; return insert(rows); });
      }
      return q;
    });
    const result = await createChildLoginAction({ memberId: 'm', username: 'emma2', pin: '1234' });
    expect(result.ok).toBe(false);
    expect(db.table('family_members')[0].user_id).toBe('attempt-a-user');
  });
});

describe('ensureActiveFamily never provisions a household for a child login', () => {
  function withProvisioning() {
    const provision = vi.fn(() => 'new-family');
    build({ ensure_family_for_user: provision });
    return provision;
  }

  it('refuses an account whose metadata marks it a child login', async () => {
    const provision = withProvisioning();
    expect(await ensureActiveFamily(db as never, { id: 'kid', user_metadata: { child: true } })).toBe(false);
    expect(provision).not.toHaveBeenCalled();
  });

  it('refuses an account that holds a child_logins row', async () => {
    const provision = withProvisioning();
    db.seed('child_logins', [{ family_id: FAMILY, member_id: 'gone', user_id: 'kid', username: 'emma' }]);
    db.seed('family_members', [{ id: 'gone', family_id: FAMILY, user_id: 'kid', role: 'child', is_active: false }]);
    expect(await ensureActiveFamily(db as never, { id: 'kid', user_metadata: {} })).toBe(false);
    expect(provision).not.toHaveBeenCalled();
    expect(db.table('families')).toHaveLength(0);
  });

  it('still provisions an ordinary new account (control)', async () => {
    const provision = vi.fn((args: Record<string, unknown>, fixture: InMemorySupabase) => {
      fixture.seed('family_members', [{ family_id: 'new-family', user_id: args.p_user_id, role: 'parent', is_active: true }]);
      return 'new-family';
    });
    build({ ensure_family_for_user: provision });
    expect(await ensureActiveFamily(db as never, { id: PARENT_USER, email: 'ada@example.test' })).toBe(true);
    expect(provision).toHaveBeenCalledTimes(1);
  });
});
