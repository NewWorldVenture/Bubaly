// An in-app member removal writes an audit record.
//
// removeFamilyMemberAction (the family page's and Settings' Remove) updated
// family_members, banned the child login, blanked the location and revoked the
// invites, then returned. There was no logAudit and no recordTrustChange; only
// failures reached console.error. The admin console's removal writes an
// adminAuditLog row with login_revocation / location_forgotten / invites_revoked,
// and the sibling updateFamilyMemberAction records a role change in the trust
// ledger — so the household had no record of a removal it could point at, and
// a partially failed removal (login still live, invite still open) survived
// only as a toast. One best-effort audit_logs row now says who removed whom and
// whether each follow-up landed. Driven through the real action against the
// in-memory database, with the real logAudit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PARENT_USER = '22222222-2222-4222-8222-222222222222';
const KID_USER = '33333333-3333-4333-8333-333333333333';
const CARER = '44444444-4444-4444-8444-444444444444';
const KID = '55555555-5555-4555-8555-555555555555';
const state = vi.hoisted(() => ({ db: null as unknown, service: null as unknown, actorRole: 'parent' as string, banError: null as null | { message: string } }));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: '22222222-2222-4222-8222-222222222222' },
    memberships: [{ familyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', role: state.actorRole }],
    active: { familyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', role: state.actorRole, member: { id: 'mum' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.service ?? state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

process.env.CHILD_LOGIN_SECRET = 'test-secret-for-derivation';
const { removeFamilyMemberAction } = await import('@/app/(app)/family/member-actions');

let db: InMemorySupabase;
let errors: unknown[][];
const audit = () => db.table('audit_logs');

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  state.actorRole = 'parent';
  state.banError = null;
  state.service = null;
  db = createInMemorySupabase({ userId: PARENT_USER });
  Object.assign(db.auth, {
    admin: {
      getUserById: async (id: string) => ({ data: { user: { id, email: id === KID_USER ? 'child.emma@kids.bubaly.app' : `${id}@example.test`, user_metadata: {}, app_metadata: {} } }, error: null }),
      updateUserById: async () => (state.banError ? { data: { user: null }, error: state.banError } : { data: { user: { id: KID_USER } }, error: null }),
    },
  });
  state.db = db;
  db.seed('family_members', [
    { id: 'mum', family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true, display_name: 'Ada' },
    { id: CARER, family_id: FAMILY, user_id: 'carer-user', role: 'caregiver', is_active: true, display_name: 'Kim', email: null },
    { id: KID, family_id: FAMILY, user_id: KID_USER, role: 'child', is_active: true, display_name: 'Emma', email: null },
  ]);
  db.seed('child_logins', [{ id: 'cl', family_id: FAMILY, member_id: KID, user_id: KID_USER, username: 'emma' }]);
});
afterEach(() => vi.restoreAllMocks());

describe('removing a member', () => {
  it('writes one audit_logs row: who removed whom, their previous role, and that every follow-up landed', async () => {
    expect(await removeFamilyMemberAction({ memberId: CARER })).toEqual({ ok: true, loginRevocation: 'none', locationForgotten: true, invitesRevoked: true });
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({
      family_id: FAMILY, actor_id: PARENT_USER, action: 'update', resource: 'family_members', resource_id: CARER,
      metadata: { removed: true, previous_role: 'caregiver', login_revocation: 'none', location_forgotten: true, invites_revoked: true, invites_they_issued_revoked: true },
    });
    expect(errors).toEqual([]);
  });

  it('records a login that could not be signed out, so the partial failure outlives the toast', async () => {
    state.banError = { message: 'auth admin unavailable' };
    expect(await removeFamilyMemberAction({ memberId: KID })).toMatchObject({ ok: true, loginRevocation: 'failed' });
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({ resource_id: KID, metadata: { removed: true, previous_role: 'child', login_revocation: 'failed', location_forgotten: true } });
  });

  it('records invites that could not be revoked', async () => {
    state.service = withFaults(db, (table, calls) => (table === 'invites' && calls.some((c) => c.method === 'update') ? { message: 'refused' } : null));
    expect(await removeFamilyMemberAction({ memberId: KID })).toMatchObject({ ok: true, invitesRevoked: false });
    expect(audit()[0]).toMatchObject({ metadata: { invites_revoked: false } });
  });

  it('a removal the audit log would not take still stands, and the lost row is loud', async () => {
    state.service = withFaults(db, (table, calls) => (table === 'audit_logs' && calls.some((c) => c.method === 'insert') ? { message: 'permission denied', code: '42501' } : null));
    expect(await removeFamilyMemberAction({ memberId: CARER })).toMatchObject({ ok: true });
    expect(db.table('family_members').find((m) => m.id === CARER)!.is_active).toBe(false);
    expect(audit()).toEqual([]);
    expect(errors.map((e) => String(e[0]))).toContain('[audit] failed to write log');
  });

  it('a refused removal records nothing (control)', async () => {
    state.actorRole = 'adult';
    expect(await removeFamilyMemberAction({ memberId: 'mum' })).toEqual({ ok: false, error: 'errors.thatChangeWasNotSaved' });
    expect(audit()).toEqual([]);
  });
});
