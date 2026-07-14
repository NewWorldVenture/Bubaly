'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { setReferralConfig } from '@/lib/referrals/server';
import { resolveReferralConfig } from '@/lib/referrals/core';

export async function saveReferralConfigAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();

  const config = resolveReferralConfig({
    enabled: formData.get('enabled') === 'on',
    referrerRewardCents: Math.round(Number(formData.get('referrerRewardDollars') || 0) * 100),
    referredRewardCents: Math.round(Number(formData.get('referredRewardDollars') || 0) * 100),
    rewardLabel: String(formData.get('rewardLabel') || ''),
  });

  try {
    await setReferralConfig(supabase, config, actorId);
  } catch (error) {
    marketingActionFailure('save the referral program settings', error);
  }
  await logMarketingAudit(supabase, {
    actorId, actorEmail, action: 'update', resource: 'referral_program', metadata: config,
  });
  revalidatePath('/admin/marketing/referrals');
}
