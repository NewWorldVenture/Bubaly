// A1 — a removed member could rejoin with any older pending invite.
//
// Removing a member wrote REMOVED_MEMBER_PATCH and left every other invite they
// held standing. accept_invite (0136) reactivates an existing (family, user)
// row with `on conflict ... set is_active = true`, so a second invite — a
// resubmitted one after a failed email, or an onboarding invite plus a later
// one — brought them straight back. And nothing in the app could revoke an
// invite at all: only the super admin console did.
//
// Driven through the real removal actions and the real join follow-up against
// the in-memory database, with accept_invite modelled on 0136's own checks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PARENT = '11111111-1111-4111-8111-111111111111';
const EX = '22222222-2222-4222-8222-222222222222';
const state = vi.hoisted(() => ({ db: null as unknown, service: null as unknown, caller: '11111111-1111-4111-8111-111111111111' }));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: '11111111-1111-4111-8111-111111111111' },
    memberships: [],
    active: { familyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', role: 'parent', member: { id: 'mum' } },
  }),
  isSuperAdmin: async () => true,
  getUser: async () => ({ id: 'super-admin' }),
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({ superAdminAssurance: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.service ?? state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { removeFamilyMemberAction } = await import('@/app/(app)/family/member-actions');
const { adminRemoveMemberAction } = await import('@/app/(app)/admin/actions');
const { settleOtherInvitesAction } = await import('@/app/join/actions');

let db: InMemorySupabase;
const invite = (id: string) => db.table('invites').find((row) => row.id === id)!;

/** accept_invite as 0136 writes it: a pending, unexpired invite to the JWT's address reactivates the row. */
function acceptInvite(args: Record<string, unknown>, mem: InMemorySupabase) {
  const row = mem.table('invites').find((i) => i.token === args.p_token);
  const caller = mem.table('auth_users').find((u) => u.id === state.caller)!;
  if (!row || row.status !== 'pending' || Date.parse(String(row.expires_at)) <= Date.now()) throw new Error('Invite is invalid or expired');
  if (String(row.email).toLowerCase() !== String(caller.email).toLowerCase()) throw new Error('This invite was issued to a different email');
  const existing = mem.table('family_members').find((m) => m.family_id === row.family_id && m.user_id === state.caller);
  if (existing) existing.is_active = true;
  else mem.table('family_members').push({ id: `m-${state.caller}`, family_id: row.family_id, user_id: state.caller, role: row.role, is_active: true });
  Object.assign(row, { status: 'accepted', accepted_by: state.caller });
  return row.family_id;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.caller = PARENT;
  db = createInMemorySupabase({ userId: PARENT, rpc: { accept_invite: acceptInvite } });
  db.seed('auth_users', [{ id: PARENT, email: 'mum@example.test' }, { id: EX, email: 'Ex.Carer@Example.test' }]);
  Object.assign(db.auth, {
    getUser: async () => ({ data: { user: db.table('auth_users').find((u) => u.id === state.caller) ?? null }, error: null }),
    admin: {
      getUserById: async (id: string) => ({ data: { user: db.table('auth_users').find((u) => u.id === id) ?? null }, error: null }),
      updateUserById: async () => ({ data: { user: null }, error: null }),
    },
  });
  state.db = db;
  state.service = null;
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
  db.seed('family_members', [
    { id: 'mum', family_id: FAMILY, user_id: PARENT, role: 'parent', is_active: true, display_name: 'Mum', email: null },
    { id: 'ex', family_id: FAMILY, user_id: EX, role: 'caregiver', is_active: true, display_name: 'Ex', email: 'old.address@example.test' },
  ]);
  db.seed('invites', [
    // The invite they joined with, and a second one from a resubmit after the email failed.
    { id: 'joined', family_id: FAMILY, email: 'ex.carer@example.test', role: 'caregiver', token: 'tok-joined', status: 'accepted', accepted_by: EX, expires_at: soon },
    { id: 'second', family_id: FAMILY, email: 'EX.CARER@example.test', role: 'adult', token: 'tok-second', status: 'pending', expires_at: soon },
    // One to the address on their roster row.
    { id: 'roster', family_id: FAMILY, email: 'old.address@example.test', role: 'adult', token: 'tok-roster', status: 'pending', expires_at: soon },
    // Controls: someone else in this family, and the same person in another family.
    { id: 'someone-else', family_id: FAMILY, email: 'gran@example.test', role: 'guest', token: 'tok-gran', status: 'pending', expires_at: soon },
    { id: 'elsewhere', family_id: OTHER, email: 'ex.carer@example.test', role: 'guest', token: 'tok-else', status: 'pending', expires_at: soon },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('removing a member revokes the invites they still hold', () => {
  it('revokes this family\'s pending invites to their account and roster addresses, and no others', async () => {
    const result = await removeFamilyMemberAction({ memberId: 'ex' });
    expect(result).toEqual({ ok: true, loginRevocation: 'none', locationForgotten: true, invitesRevoked: true });
    expect(invite('second').status).toBe('revoked');
    expect(invite('roster').status).toBe('revoked');
    expect(invite('joined').status).toBe('accepted');
    expect(invite('someone-else').status).toBe('pending');
    expect(invite('elsewhere').status).toBe('pending');
  });

  it('so the second invite no longer brings them back', async () => {
    await removeFamilyMemberAction({ memberId: 'ex' });
    expect(db.table('family_members').find((m) => m.id === 'ex')).toMatchObject({ is_active: false, role: 'guest' });
    state.caller = EX;
    const { error } = await db.rpc('accept_invite', { p_token: 'tok-second' });
    expect(error?.message).toBe('Invite is invalid or expired');
    expect(db.table('family_members').find((m) => m.id === 'ex')).toMatchObject({ is_active: false });
  });

  it('keeps the removal and says so when the invites could not be revoked', async () => {
    state.service = withFaults(db, (table, calls) => (table === 'invites' && calls.some((c) => c.method === 'update') ? { message: 'refused' } : null));
    const result = await removeFamilyMemberAction({ memberId: 'ex' });
    expect(result).toEqual({ ok: true, loginRevocation: 'none', locationForgotten: true, invitesRevoked: false });
    expect(db.table('family_members').find((m) => m.id === 'ex')!.is_active).toBe(false);
    expect(invite('second').status).toBe('pending');
  });

  it('the super admin\'s removal revokes them too', async () => {
    expect(await adminRemoveMemberAction('ex')).toEqual({ ok: true });
    expect(invite('second').status).toBe('revoked');
    expect(invite('elsewhere').status).toBe('pending');
  });
});

describe('joining through one invite closes the others to the same address', () => {
  it('expires the caller\'s sibling invites in the families they belong to', async () => {
    db.replace('family_members', [{ id: 'mum', family_id: FAMILY, user_id: PARENT, role: 'parent', is_active: true }]);
    db.table('invites').find((i) => i.id === 'joined')!.status = 'pending';
    state.caller = EX;
    expect((await db.rpc('accept_invite', { p_token: 'tok-joined' })).error).toBeNull();
    expect(await settleOtherInvitesAction()).toEqual({ ok: true });
    expect(invite('joined').status).toBe('accepted');
    expect(invite('second').status).toBe('expired');
    // Another family's invite is theirs to accept or ignore; and the roster address is not this account's.
    expect(invite('elsewhere').status).toBe('pending');
    expect(invite('roster').status).toBe('pending');
    expect(invite('someone-else').status).toBe('pending');
  });
});
