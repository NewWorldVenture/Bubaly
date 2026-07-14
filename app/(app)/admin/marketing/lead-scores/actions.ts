'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { recomputeAllContactScores } from '@/lib/marketing/contact-score-compute';

/** Recompute every contact's lead score from the current signals (admin only). */
export async function recomputeLeadScoresAction(): Promise<{ scored: number }> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  let scored: number;
  try {
    scored = await recomputeAllContactScores(supabase, 2000);
  } catch (error) {
    marketingActionFailure('recompute lead scores', error);
  }
  await logMarketingAudit(supabase, {
    actorId, actorEmail, action: 'recompute', resource: 'crm_lead_scores', metadata: { scored },
  });
  revalidatePath('/admin/marketing/lead-scores');
  return { scored };
}
