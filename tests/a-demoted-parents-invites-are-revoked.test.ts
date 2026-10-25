// The pending invites a DEMOTED member sent, at a role they may no longer
// give, are revoked with the demotion (N3-S1).
//
// Removal revokes every pending invite the removed member issued
// (revokeInvitesIssuedBy), because accept_invite (0136) checks the token,
// status, expiry and address — never whether `invited_by` may still send an
// invite at that role. A role change did not: a parent made an adult (or a
// guest) left their 'parent' invites pending, and accept_invite still enrolled
// the invitee as a parent for up to 14 days. Both editors — the household's
// updateFamilyMemberAction and the console's adminUpdateMemberAction — now
// revoke the invites the new role could not send, and say so when they could
// not. The SQL re-check in accept_invite (AUD16-O02) stays the owner's.
//
// Driven through the real actions against the in-memory database, with
// accept_invite modelled on 0136's own checks (as the removal test does).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { inviteRolesLostOnRoleChange } from '@/lib/constants/roles';

const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PARENT = '11111111-1111-4111-8111-111111111111';
const EX = '22222222-2222-4222-8222-222222222222';
const GRAN = '33333333-3333-4333-8333-333333333333';
const state = vi.hoisted(() => ({ db: null as unknown, service: null as unknown, caller: '11111111-1111-4111-8111-111111111111', audits: [] as Record<string, unknown>[] }));

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
vi.mock('@/lib/server/audit', () => ({ logAudit: async (_db: unknown, entry: Record<string, unknown>) => { state.audits.push(entry); } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { updateFamilyMemberAction } = await import('@/app/(app)/family/member-actions');
const { adminUpdateMemberAction } = await import('@/app/(app)/admin/actions');

let db: InMemorySupabase;
const invite = (id: string) => db.table('invites').find((row) => row.id === id)!;
const member = (id: string) => db.table('family_members').find((row) => row.id === id)!;
const demote = (role: 'adult' | 'teen' | 'guest' | 'parent', id = 'ex') => updateFamilyMemberAction({
  memberId: id, expectedUpdatedAt: member(id).updated_at as string, changes: { role },
});

/** accept_invite as 0136 writes it: a pending, unexpired invite to the JWT's address enrols the caller at the invite's role. */
function acceptInvite(args: Record<string, unknown>, mem: InMemorySupabase) {
  const row = mem.table('invites').find((i) => i.token === args.p_token);
  const caller = mem.table('auth_users').find((u) => u.id === state.caller)!;
  if (!row || row.status !== 'pending' || Date.parse(String(row.expires_at)) <= Date.now()) throw new Error('Invite is invalid or expired');
  if (String(row.email).toLowerCase() !== String(caller.email).toLowerCase()) throw new Error('This invite was issued to a different email');
  mem.table('family_members').push({ id: `m-${state.caller}`, family_id: row.family_id, user_id: state.caller, role: row.role, is_active: true });
  Object.assign(row, { status: 'accepted', accepted_by: state.caller });
  return row.family_id;
}

/** Refuses only the revocation of the invites the member ISSUED. */
const issuedByRevocationRefused = (table: string, calls: { method: string; args: unknown[] }[]) => (
  table === 'invites' && calls.some((c) => c.method === 'update') && calls.some((c) => c.method === 'eq' && c.args[0] === 'invited_by')
    ? { message: 'refused' } : null
);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.caller = PARENT;
  state.audits = [];
  db = createInMemorySupabase({ userId: PARENT, rpc: { accept_invite: acceptInvite } });
  db.seed('auth_users', [
    { id: PARENT, email: 'mum@example.test' }, { id: EX, email: 'ex@example.test' }, { id: GRAN, email: 'gran@example.test' },
  ]);
  Object.assign(db.auth, {
    getUser: async () => ({ data: { user: db.table('auth_users').find((u) => u.id === state.caller) ?? null }, error: null }),
    admin: { getUserById: async (id: string) => ({ data: { user: db.table('auth_users').find((u) => u.id === id) ?? null }, error: null }) },
  });
  state.db = db;
  state.service = null;
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const stamp = '2026-10-01T00:00:00.000Z';
  db.seed('family_members', [
    { id: 'mum', family_id: FAMILY, user_id: PARENT, role: 'parent', is_active: true, display_name: 'Mum', birthday: null, email: null, phone: null, updated_at: stamp },
    // A second parent, about to be demoted, who invited Gran as a PARENT.
    { id: 'ex', family_id: FAMILY, user_id: EX, role: 'parent', is_active: true, display_name: 'Ex', birthday: null, email: null, phone: null, updated_at: stamp },
  ]);
  db.seed('invites', [
    // What the demoted parent issued: Gran as a parent, a neighbour as a guest.
    { id: 'gran-by-ex', family_id: FAMILY, email: 'gran@example.test', role: 'parent', token: 'tok-gran', status: 'pending', expires_at: soon, invited_by: EX },
    { id: 'neighbour-by-ex', family_id: FAMILY, email: 'neighbour@example.test', role: 'guest', token: 'tok-neighbour', status: 'pending', expires_at: soon, invited_by: EX },
    // Controls: the staying parent's own parent invite, and one the demoted
    // parent issued in ANOTHER family, where they are still a parent.
    { id: 'by-mum', family_id: FAMILY, email: 'uncle@example.test', role: 'parent', token: 'tok-uncle', status: 'pending', expires_at: soon, invited_by: PARENT },
    { id: 'elsewhere-by-ex', family_id: OTHER, email: 'friend@example.test', role: 'parent', token: 'tok-friend', status: 'pending', expires_at: soon, invited_by: EX },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('the invite roles a role change takes away', () => {
  it('a parent made an adult loses parent; one who stops managing loses every role; a promotion loses none', () => {
    expect(inviteRolesLostOnRoleChange('parent', 'adult')).toEqual(['parent', 'child']);
    expect(inviteRolesLostOnRoleChange('parent', 'guest')).toEqual(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest']);
    expect(inviteRolesLostOnRoleChange('adult', 'teen')).toEqual(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest']);
    expect(inviteRolesLostOnRoleChange('adult', 'parent')).toEqual([]);
    expect(inviteRolesLostOnRoleChange('teen', 'child')).toEqual([]);
  });
});

describe('demoting a parent from the household\'s editor', () => {
  it('to adult revokes the parent invites they sent, and leaves the ones an adult may still send', async () => {
    expect(await demote('adult')).toEqual({ ok: true });
    expect(member('ex').role).toBe('adult');
    expect(invite('gran-by-ex').status).toBe('revoked');
    expect(invite('neighbour-by-ex').status).toBe('pending');
    expect(invite('by-mum').status).toBe('pending');
    expect(invite('elsewhere-by-ex').status).toBe('pending');
  });

  it('so Gran can no longer join as a parent on the demoted parent\'s word', async () => {
    await demote('adult');
    state.caller = GRAN;
    const { error } = await db.rpc('accept_invite', { p_token: 'tok-gran' });
    expect(error?.message).toBe('Invite is invalid or expired');
    expect(db.table('family_members').some((m) => m.user_id === GRAN)).toBe(false);
  });

  it('to guest revokes every pending invite they sent in this family', async () => {
    expect(await demote('guest')).toEqual({ ok: true });
    expect(invite('gran-by-ex').status).toBe('revoked');
    expect(invite('neighbour-by-ex').status).toBe('revoked');
    expect(invite('by-mum').status).toBe('pending');
    expect(invite('elsewhere-by-ex').status).toBe('pending');
  });

  it('promoting an adult revokes nothing', async () => {
    member('ex').role = 'adult';
    invite('gran-by-ex').role = 'guest';
    expect(await demote('parent')).toEqual({ ok: true });
    expect(invite('gran-by-ex').status).toBe('pending');
    expect(invite('neighbour-by-ex').status).toBe('pending');
  });

  it('keeps the role change and says so when their invites could not be revoked', async () => {
    state.service = withFaults(db, issuedByRevocationRefused);
    expect(await demote('adult')).toEqual({ ok: true, invitesRevoked: false });
    expect(member('ex').role).toBe('adult');
    expect(invite('gran-by-ex').status).toBe('pending');
  });
});

describe('demoting a parent from the console', () => {
  it('revokes the parent invites they sent, and its audit row says so', async () => {
    expect(await adminUpdateMemberAction('ex', { displayName: 'Ex', role: 'adult' })).toEqual({ ok: true });
    expect(invite('gran-by-ex').status).toBe('revoked');
    expect(invite('neighbour-by-ex').status).toBe('pending');
    expect(invite('by-mum').status).toBe('pending');
    expect(invite('elsewhere-by-ex').status).toBe('pending');
    expect(state.audits).toContainEqual(expect.objectContaining({
      resource: 'family_members', resourceId: 'ex',
      metadata: expect.objectContaining({ role: 'adult', invites_they_issued_revoked: true }),
    }));
  });

  it('warns when it could not revoke them, and the role change stands', async () => {
    state.service = withFaults(db, issuedByRevocationRefused);
    expect(await adminUpdateMemberAction('ex', { displayName: 'Ex', role: 'adult' }))
      .toEqual({ ok: true, data: { warning: 'familyModule.roleChangedButInviteStillOpen' } });
    expect(member('ex').role).toBe('adult');
    expect(invite('gran-by-ex').status).toBe('pending');
  });
});
