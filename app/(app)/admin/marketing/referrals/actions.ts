'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
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

  await setReferralConfig(supabase, config, actorId);
  await logMarketingAudit(supabase, {
    actorId, actorEmail, action: 'update', resource: 'referral_program', metadata: config,
  });
  revalidatePath('/admin/marketing/referrals');
}
