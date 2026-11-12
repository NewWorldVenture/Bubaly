// saveReferralConfigAction (app/(app)/admin/marketing/referrals/actions.ts),
// called as every kind of caller with a valid form.
//
// THE POLICY. The referral amounts become real Stripe credits for both families
// on every referral (actions.ts:12-13). They are a site-wide marketing setting
// in marketing_settings, not family data: setReferralConfig is "admin only —
// caller must be gated" (lib/referrals/server.ts:36), and the action gates with
// requireMarketingAdmin (actions.ts:10; lib/marketing/admin.ts:79-89), which
// throws for anyone but a super admin who has passed two-step. A household's
// parent is not a platform admin, and there is no "other family" to reach.
//
// WHAT IS ASSERTED: the super admin's save writes exactly the new config and
// one audit row holding both the previous and next amounts; every other caller
// is refused with the gate's status and every table is unchanged.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: vi.fn() }));

const { saveReferralConfigAction } = await import('@/app/(app)/admin/marketing/referrals/actions');

const ID = 'ACTION-8DDFD84D2ECE';
const PREVIOUS = { enabled: true, referrerRewardCents: 500, referredRewardCents: 500, rewardLabel: '$5 off' };
let db: InMemorySupabase;

const form = () => {
  const fd = new FormData();
  fd.set('enabled', 'on');
  fd.set('referrerRewardDollars', '10');
  fd.set('referredRewardDollars', '10');
  fd.set('rewardLabel', '$10 off');
  return fd;
};

beforeEach(() => {
  h.revalidatePath.mockReset();
  db = newAdminWorld();
  db.seed('marketing_settings', [{ key: 'referral_program', value: PREVIOUS, updated_by: null }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe(`${ID} saveReferralConfigAction`, () => {
  it(`${ID} a super admin sets the rewards, and the audit row holds both sides`, async () => {
    signInAs({ kind: 'super_admin' });
    await saveReferralConfigAction(form());
    const next = { enabled: true, referrerRewardCents: 1000, referredRewardCents: 1000, rewardLabel: '$10 off' };
    expect(db.table('marketing_settings')).toEqual([
      expect.objectContaining({ key: 'referral_program', value: next, updated_by: SUPER_ADMIN.id }),
    ]);
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      actor_id: SUPER_ADMIN.id, actor_email: SUPER_ADMIN.email, action: 'update', resource: 'referral_program',
      metadata: { previous: PREVIOUS, next },
    })]);
    expect(h.revalidatePath).toHaveBeenCalledWith('/admin/marketing/referrals');
  });

  it.each(REFUSED_CALLERS)(`${ID} $label is refused and nothing is written`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(saveReferralConfigAction(form())).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
