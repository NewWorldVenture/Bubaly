import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

// admin-writers R5-AW-REVOKED-ACCEPTED-INVITE. adminRevokeInviteAction is the
// super admin's Revoke on /admin/users, which the page shows only on the rows
// that were pending when it rendered. The update was keyed by id alone, so a
// stale page reached an invite the invitee had accepted since: its status was
// overwritten to 'revoked' with accepted_by kept, the screen said "Invite
// revoked", and the audit log recorded a revoke of someone already in the
// family. An accepted invite is also what the marketing push audience reads to
// keep a removed teen out (lib/marketing/push-audience.ts). For a client role,
// 0482 already allows only pending -> revoked; this holds the service-role
// action to the same rule. The REAL action over the in-memory database.
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'admin-1', email: 'root@example.com' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { adminRevokeInviteAction } = await import('@/app/(app)/admin/actions');

let db: InMemorySupabase;

const invite = (id: string, status: string, acceptedBy: string | null = null) => ({
  id, family_id: 'fam-1', email: `${id}@example.test`, role: 'teen', status, token: `tok-${id}`, invited_by: 'user-9', accepted_by: acceptedBy,
  created_at: '2026-10-01T00:00:00.000Z', expires_at: '2026-10-15T00:00:00.000Z',
});
const row = (id: string) => db.table('invites').find((r) => r.id === id);
const audits = () => db.table('audit_logs');

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  db.seed('audit_logs', []);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the super admin revokes only an invite that is still pending', () => {
  it('an invite accepted since the page rendered is left accepted, is not reported revoked, and is not audited as a revoke', async () => {
    db.seed('invites', [invite('inv-1', 'accepted', 'u-teen')]);
    expect(await adminRevokeInviteAction('inv-1')).toEqual({ ok: false, error: SOURCE_MESSAGES['actions.inviteIsNoLongerPending'] });
    expect(row('inv-1'), 'an accepted invite was overwritten to revoked').toMatchObject({ status: 'accepted', accepted_by: 'u-teen' });
    expect(audits(), 'a revoke of an accepted invite was audited').toEqual([]);
  });

  it.each(['revoked', 'expired'])('an invite already %s is not revoked again or audited again', async (status) => {
    db.seed('invites', [invite('inv-1', status)]);
    expect(await adminRevokeInviteAction('inv-1')).toEqual({ ok: false, error: SOURCE_MESSAGES['actions.inviteIsNoLongerPending'] });
    expect(row('inv-1')).toMatchObject({ status });
    expect(audits()).toEqual([]);
  });

  it('an invite that is gone is no longer pending, not a failure to revoke', async () => {
    expect(await adminRevokeInviteAction('inv-missing')).toEqual({ ok: false, error: SOURCE_MESSAGES['actions.inviteIsNoLongerPending'] });
    expect(audits()).toEqual([]);
  });

  it('controls: a pending invite is revoked and audited, and a refused write is reported, not audited', async () => {
    db.seed('invites', [invite('inv-1', 'pending'), invite('inv-2', 'pending')]);
    expect(await adminRevokeInviteAction('inv-1')).toEqual({ ok: true });
    expect(row('inv-1')).toMatchObject({ status: 'revoked', accepted_by: null });
    expect(row('inv-2'), 'another pending invite was revoked with it').toMatchObject({ status: 'pending' });
    expect(audits()).toEqual([expect.objectContaining({ family_id: 'fam-1', action: 'revoke', resource: 'invites', actor_id: 'admin-1', metadata: expect.objectContaining({ email: 'inv-1@example.test', via: 'site_admin' }) })]);

    h.db = withFaults(db, (table) => (table === 'invites' ? { message: 'permission denied for table invites' } : null));
    const refused = await adminRevokeInviteAction('inv-2');
    expect(refused.ok).toBe(false);
    expect(refused).not.toEqual({ ok: false, error: SOURCE_MESSAGES['actions.inviteIsNoLongerPending'] });
    expect(row('inv-2')).toMatchObject({ status: 'pending' });
    expect(audits()).toHaveLength(1);
  });
});
