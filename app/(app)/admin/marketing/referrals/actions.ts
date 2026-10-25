'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { getReferralConfigResult, setReferralConfig } from '@/lib/referrals/server';
import { MAX_REFERRAL_REWARD_CENTS, resolveReferralConfig, rewardCentsFromDollars, rewardLabelMatchesAmounts } from '@/lib/referrals/core';
import { refuseInput } from '@/lib/actions/refusal';

export async function saveReferralConfigAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();

  // Each amount becomes a real Stripe credit to both families on every referral
  // made while it stands, so an amount out of bounds is refused, never clamped.
  const referrerRewardCents = rewardCentsFromDollars(String(formData.get('referrerRewardDollars') ?? ''));
  const referredRewardCents = rewardCentsFromDollars(String(formData.get('referredRewardDollars') ?? ''));
  if (referrerRewardCents === null || referredRewardCents === null) {
    refuseInput(`Each reward must be a whole number of cents from $0 to $${MAX_REFERRAL_REWARD_CENTS / 100}.`);
  }
  const config = resolveReferralConfig({
    enabled: formData.get('enabled') === 'on',
    referrerRewardCents,
    referredRewardCents,
    rewardLabel: String(formData.get('rewardLabel') || ''),
  });
  if (!rewardLabelMatchesAmounts(config)) refuseInput('The reward label states an amount the rewards do not pay.');

  // The audit row is the only history of the amounts, so it records both sides.
  const { config: previous, error: readError } = await getReferralConfigResult(supabase);
  if (readError) marketingActionFailure('read the current referral program settings', readError);

  try {
    await setReferralConfig(supabase, config, actorId);
  } catch (error) {
    marketingActionFailure('save the referral program settings', error);
  }
  await logMarketingAudit(supabase, {
    actorId, actorEmail, action: 'update', resource: 'referral_program', metadata: { previous, next: config },
  });
  revalidatePath('/admin/marketing/referrals');
}
