'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { applyReferralCode, type ApplyResult } from '@/lib/referrals/server';

export async function applyReferralCodeAction(rawCode: string): Promise<ApplyResult> {
  const ctx = await requireUserContext();
  const result = await applyReferralCode({
    rawCode,
    referredFamilyId: ctx.active.familyId,
    referredEmail: ctx.user.email,
    source: 'apply_code',
  });
  if (result.ok) revalidatePath('/referrals');
  return result;
}
