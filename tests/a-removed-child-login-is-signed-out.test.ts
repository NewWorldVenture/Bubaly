import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// Removing a member is a soft `is_active = false`. The child-login sign-in
// refuses an inactive member, but a child who was ALREADY signed in kept a
// valid session, and with it could POST /rest/v1/families and become a parent
// through handle_new_family. Every removal path now bans a removed member's
// child login with the service role (GoTrue then refuses its refresh and every
// new sign-in). The removal must stand even if that ban fails, and the failure
// must be logged and reported.

const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PARENT_USER = '22222222-2222-4222-8222-222222222222';
const KID_USER = '33333333-3333-4333-8333-333333333333';
const state = vi.hoisted(() => ({
  db: null as unknown,
  actorRole: 'parent' as string,
  bans: [] as Array<{ id: string; attrs: Record<string, unknown> }>,
  banError: null as null | { message: string },
  metadata: {} as Record<string, unknown>,
}));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: '22222222-2222-4222-8222-222222222222' },
    memberships: [{ familyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', role: state.actorRole }],
    active: { familyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', role: state.actorRole },
  }),
  isSuperAdmin: async () => true,
  getUser: async () => ({ id: 'super-admin' }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { removeFamilyMemberAction } = await import('@/app/(app)/family/member-actions');
const { adminRemoveMemberAction } = await import('@/app/(app)/admin/actions');
const { revokeRemovedChildLogin } = await import('@/lib/server/child-account');

let db: InMemorySupabase;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.actorRole = 'parent';
  state.bans = [];
  state.banError = null;
  state.metadata = {};
  db = createInMemorySupabase({ userId: PARENT_USER });
  Object.assign(db.auth, { admin: {
    getUserById: async (id: string) => ({ data: { user: { id, user_metadata: state.metadata } }, error: null }),
    updateUserById: async (id: string, attrs: Record<string, unknown>) => {
      if (state.banError) return { data: { user: null }, error: state.banError };
      state.bans.push({ id, attrs });
      return { data: { user: { id } }, error: null };
    },
  } });
  state.db = db;
  db.seed('family_members', [
    { id: 'kid', family_id: FAMILY, user_id: KID_USER, role: 'child', is_active: true, display_name: 'Emma' },
    { id: 'aunt', family_id: FAMILY, user_id: 'aunt-user', role: 'adult', is_active: true, display_name: 'Ann' },
    { id: 'local', family_id: FAMILY, user_id: null, role: 'child', is_active: true, display_name: 'Leo' },
    { id: 'mum', family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true, display_name: 'Ada' },
  ]);
  db.seed('child_logins', [{ id: 'cl', family_id: FAMILY, member_id: 'kid', user_id: KID_USER, username: 'emma' }]);
});

const row = (id: string) => db.table('family_members').find((m) => m.id === id)!;

describe('removeFamilyMemberAction', () => {
  it("removes a child and bans their PIN login's account", async () => {
    const result = await removeFamilyMemberAction({ memberId: 'kid', familyId: FAMILY });
    expect(result).toEqual({ ok: true, loginRevocation: 'revoked' });
    expect(row('kid')).toMatchObject({ is_active: false, role: 'guest' });
    expect(state.bans).toHaveLength(1);
    expect(state.bans[0].id).toBe(KID_USER);
    expect(state.bans[0].attrs.ban_duration).toEqual(expect.stringMatching(/^\d+h$/));
  });

  it('still removes the child when the ban fails, and logs and reports it', async () => {
    state.banError = { message: 'auth admin unavailable' };
    const result = await removeFamilyMemberAction({ memberId: 'kid', familyId: FAMILY });
    expect(result).toEqual({ ok: true, loginRevocation: 'failed' });
    expect(row('kid')).toMatchObject({ is_active: false, role: 'guest' });
    expect(console.error).toHaveBeenCalled();
  });

  it('bans an account whose metadata marks it a child login even without a child_logins row', async () => {
    db.replace('child_logins', []);
    state.metadata = { child: true };
    expect(await removeFamilyMemberAction({ memberId: 'kid', familyId: FAMILY })).toEqual({ ok: true, loginRevocation: 'revoked' });
    expect(state.bans.map((b) => b.id)).toEqual([KID_USER]);
  });

  it('never bans an ordinary account, which may belong to other households (control)', async () => {
    expect(await removeFamilyMemberAction({ memberId: 'aunt', familyId: FAMILY })).toEqual({ ok: true, loginRevocation: 'none' });
    expect(await removeFamilyMemberAction({ memberId: 'local', familyId: FAMILY })).toEqual({ ok: true, loginRevocation: 'none' });
    expect(state.bans).toEqual([]);
    expect(row('aunt').is_active).toBe(false);
  });

  it('an adult cannot remove a parent through it', async () => {
    state.actorRole = 'adult';
    const result = await removeFamilyMemberAction({ memberId: 'mum', familyId: FAMILY });
    expect(result).toEqual({ ok: false, error: 'errors.thatChangeWasNotSaved' });
    expect(row('mum')).toMatchObject({ is_active: true, role: 'parent' });
  });

  it('refuses a family the caller is not a member of', async () => {
    const result = await removeFamilyMemberAction({ memberId: 'kid', familyId: 'someone-elses' });
    expect(result.ok).toBe(false);
    expect(row('kid').is_active).toBe(true);
    expect(state.bans).toEqual([]);
  });
});

describe('revokeRemovedChildLogin does not fail closed into a ban', () => {
  it('reports a lookup it cannot answer as failed, banning nobody', async () => {
    vi.spyOn(db, 'from').mockImplementation(() => { throw new Error('offline'); });
    expect(await revokeRemovedChildLogin(db as never, { id: 'kid', family_id: FAMILY, user_id: KID_USER })).toBe('failed');
    expect(state.bans).toEqual([]);
  });
});

describe('adminRemoveMemberAction', () => {
  it('bans a removed child login too', async () => {
    expect(await adminRemoveMemberAction('kid')).toEqual({ ok: true });
    expect(row('kid')).toMatchObject({ is_active: false, role: 'guest' });
    expect(state.bans.map((b) => b.id)).toEqual([KID_USER]);
  });

  it('keeps the removal and returns a warning when the ban fails', async () => {
    state.banError = { message: 'auth admin unavailable' };
    expect(await adminRemoveMemberAction('kid')).toEqual({ ok: true, data: { warning: 'familyModule.removedButLoginStillActive' } });
    expect(row('kid').is_active).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('the in-app removal screens go through the server action', () => {
  it.each(['components/modules/family-module.tsx', 'components/modules/settings-module.tsx'])('%s', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('removeFamilyMemberAction(');
    expect(src).toContain("'familyModule.removedButLoginStillActive'");
    expect(src).not.toContain('REMOVED_MEMBER_PATCH');
  });
});
