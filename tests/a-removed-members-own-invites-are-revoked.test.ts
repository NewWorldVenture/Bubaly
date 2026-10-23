// The pending invites a removed member SENT are revoked with them.
//
// Removing a member closed the pending invites addressed TO them
// (closePendingInvitesFor) and left the ones they had ISSUED standing.
// accept_invite (0136) checks the token, status, expiry and address — never
// whether `invited_by` is still an active manager — so an invite a removed
// parent sent kept enrolling its invitee at the role that parent chose,
// 'parent' included, for up to 14 days. The SQL re-check in accept_invite is
// the recorded owner action (AUD16-O02); both removal paths now revoke those
// rows the moment the member is removed, and a revocation that could not be
// made is folded into the same `invitesRevoked` the screen already reports.
//
// Driven through the real removal actions against the in-memory database, with
// accept_invite modelled on 0136's own checks (as the sibling test does).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

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

const { removeFamilyMemberAction } = await import('@/app/(app)/family/member-actions');
const { adminRemoveMemberAction } = await import('@/app/(app)/admin/actions');

let db: InMemorySupabase;
const invite = (id: string) => db.table('invites').find((row) => row.id === id)!;

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
    // A second parent, about to be removed, who invited Gran as a PARENT.
    { id: 'ex', family_id: FAMILY, user_id: EX, role: 'parent', is_active: true, display_name: 'Ex', email: null },
  ]);
  db.seed('invites', [
    // What the removed parent issued: Gran as a parent, a neighbour as a guest.
    { id: 'gran-by-ex', family_id: FAMILY, email: 'gran@example.test', role: 'parent', token: 'tok-gran', status: 'pending', expires_at: soon, invited_by: EX },
    { id: 'neighbour-by-ex', family_id: FAMILY, email: 'neighbour@example.test', role: 'guest', token: 'tok-neighbour', status: 'pending', expires_at: soon, invited_by: EX },
    // Already accepted: history, not an open door.
    { id: 'done-by-ex', family_id: FAMILY, email: 'aunt@example.test', role: 'adult', token: 'tok-aunt', status: 'accepted', expires_at: soon, invited_by: EX },
    // Controls: an invite the staying parent issued, and one the removed
    // parent issued in ANOTHER family they belong to.
    { id: 'by-mum', family_id: FAMILY, email: 'uncle@example.test', role: 'adult', token: 'tok-uncle', status: 'pending', expires_at: soon, invited_by: PARENT },
    { id: 'elsewhere-by-ex', family_id: OTHER, email: 'friend@example.test', role: 'guest', token: 'tok-friend', status: 'pending', expires_at: soon, invited_by: EX },
  ]);
});
afterEach(() => vi.restoreAllMocks());

/** Refuses only the revocation of the invites the removed member ISSUED; the ones addressed TO them still close. */
const issuedByRevocationRefused = (table: string, calls: { method: string; args: unknown[] }[]) => (
  table === 'invites' && calls.some((c) => c.method === 'update') && calls.some((c) => c.method === 'eq' && c.args[0] === 'invited_by')
    ? { message: 'refused' } : null
);

describe('removing a parent who had sent invites', () => {
  it('revokes this family\'s pending invites they issued, and no others', async () => {
    const result = await removeFamilyMemberAction({ memberId: 'ex' });
    expect(result).toEqual({ ok: true, loginRevocation: 'none', locationForgotten: true, invitesRevoked: true });
    expect(invite('gran-by-ex').status).toBe('revoked');
    expect(invite('neighbour-by-ex').status).toBe('revoked');
    expect(invite('done-by-ex').status).toBe('accepted');
    expect(invite('by-mum').status).toBe('pending');
    expect(invite('elsewhere-by-ex').status).toBe('pending');
  });

  it('so Gran can no longer join as a parent on the removed parent\'s word', async () => {
    await removeFamilyMemberAction({ memberId: 'ex' });
    state.caller = GRAN;
    const { error } = await db.rpc('accept_invite', { p_token: 'tok-gran' });
    expect(error?.message).toBe('Invite is invalid or expired');
    expect(db.table('family_members').some((m) => m.user_id === GRAN)).toBe(false);
  });

  it('a removed member with no account issued nothing, and the answer is still a clean removal', async () => {
    db.seed('family_members', [{ id: 'local', family_id: FAMILY, user_id: null, role: 'child', is_active: true, display_name: 'Leo', email: null }]);
    const result = await removeFamilyMemberAction({ memberId: 'local' });
    expect(result).toEqual({ ok: true, loginRevocation: 'none', locationForgotten: true, invitesRevoked: true });
    expect(invite('by-mum').status).toBe('pending');
  });

  it('keeps the removal and says so when their invites could not be revoked', async () => {
    state.service = withFaults(db, issuedByRevocationRefused);
    const result = await removeFamilyMemberAction({ memberId: 'ex' });
    expect(result).toEqual({ ok: true, loginRevocation: 'none', locationForgotten: true, invitesRevoked: false });
    expect(db.table('family_members').find((m) => m.id === 'ex')!.is_active).toBe(false);
    expect(invite('gran-by-ex').status).toBe('pending');
  });

  it('the super admin\'s removal revokes them too, and its audit row says so', async () => {
    expect(await adminRemoveMemberAction('ex')).toEqual({ ok: true });
    expect(invite('gran-by-ex').status).toBe('revoked');
    expect(invite('neighbour-by-ex').status).toBe('revoked');
    expect(invite('by-mum').status).toBe('pending');
    expect(invite('elsewhere-by-ex').status).toBe('pending');
    expect(state.audits).toContainEqual(expect.objectContaining({
      action: 'remove', resource: 'family_members', resourceId: 'ex',
      metadata: expect.objectContaining({ invites_revoked: true, invites_they_issued_revoked: true }),
    }));
  });

  it('and reports a revocation it could not make, as it reports the other follow-ups', async () => {
    state.service = withFaults(db, issuedByRevocationRefused);
    expect(await adminRemoveMemberAction('ex')).toEqual({ ok: true, data: { warning: 'familyModule.removedButInviteStillOpen' } });
    expect(state.audits).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({ invites_revoked: false, invites_they_issued_revoked: false }),
    }));
  });
});
