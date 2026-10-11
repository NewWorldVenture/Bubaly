import { beforeEach, describe, expect, it, vi } from 'vitest';

// With RESEND_API_KEY unset the sender answers `{ ok: true, skipped: true }`
// and sends nothing. Two actions read only `ok`:
//
// - sendReferralEmailAction told the member their referral email had gone, and
//   kept the invite record, which counts toward the family's daily limit, for
//   a mail that was never sent. A failed send already rolls that record back.
// - adminResendInviteAction told the super admin the invite was re-sent and
//   wrote a `resend` row to the admin audit log for a send that did not happen.
//
// Fixed on main by #619 (API-SWEEP-07); this drives both actions through that fix.

const state = vi.hoisted(() => ({
  result: { ok: true, skipped: true } as { ok: boolean; skipped?: boolean },
  rollbacks: 0,
  audits: 0,
}));

// The admin gates also ask lib/auth/super-admin-assurance whether the session
// proved its authenticator; this file is not about step-up, so it says yes.
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://www.bubaly.com', sendReactEmail: async () => state.result }));
vi.mock('@/lib/emails/referral', () => ({ ReferralEmail: () => null }));
vi.mock('@/lib/emails/invite', () => ({ InviteEmail: () => null }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u1', email: 'parent@example.test' },
    active: { familyId: 'f1', member: { display_name: 'Pat' }, family: { name: 'Fixture' } },
  }),
  getUser: async () => ({ id: 'admin-1', email: 'admin@example.test' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/referrals/server', () => ({
  applyReferralCode: async () => ({ ok: true }),
  getOrCreateReferralCode: async () => 'CODE1234',
  getReferralConfig: async () => ({ enabled: true, rewardLabel: 'a free month' }),
  recordReferralEmailInvite: async () => ({ ok: true, rowId: 'row-1', created: true }),
  rollbackReferralEmailInvite: async () => { state.rollbacks++; },
}));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => { state.audits++; return { ok: true }; } }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({}),
  createServiceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b, eq: () => b,
        maybeSingle: async () => ({
          data: table === 'invites'
            ? { id: 'inv-1', status: 'pending', email: 'partner@example.test', family_id: 'f1', invited_by: null, token: 'tok', role: 'parent' }
            : { name: 'Fixture' },
          error: null,
        }),
      });
      return b;
    },
  }),
}));

beforeEach(() => {
  state.rollbacks = 0;
  state.audits = 0;
});

describe('a send nobody received is not a success', () => {
  it('the referral email: no provider → not ok, and the invite record is rolled back', async () => {
    state.result = { ok: true, skipped: true };
    const { sendReferralEmailAction } = await import('@/app/(app)/referrals/actions');
    const res = await sendReferralEmailAction('friend@example.test');
    expect(res.ok).toBe(false);
    expect(state.rollbacks).toBe(1);
  });

  it('the referral email: a delivered send is still ok, and kept', async () => {
    state.result = { ok: true };
    const { sendReferralEmailAction } = await import('@/app/(app)/referrals/actions');
    const res = await sendReferralEmailAction('friend@example.test');
    expect(res.ok).toBe(true);
    expect(state.rollbacks).toBe(0);
  });

  it('the admin resend: no provider → not ok, and no resend is audited', async () => {
    state.result = { ok: true, skipped: true };
    const { adminResendInviteAction } = await import('@/app/(app)/admin/actions');
    const res = await adminResendInviteAction('inv-1');
    expect(res.ok).toBe(false);
    expect(state.audits).toBe(0);
  });

  it('the admin resend: a delivered send is still ok, and audited', async () => {
    state.result = { ok: true };
    const { adminResendInviteAction } = await import('@/app/(app)/admin/actions');
    const res = await adminResendInviteAction('inv-1');
    expect(res.ok).toBe(true);
    expect(state.audits).toBe(1);
  });
});
