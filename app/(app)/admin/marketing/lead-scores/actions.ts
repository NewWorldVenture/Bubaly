'use server';

import { revalidatePath } from 'next/cache';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { recomputeAllContactScores } from '@/lib/marketing/contact-score-compute';

/** Recompute every contact's lead score from the current signals (admin only). */
export async function recomputeLeadScoresAction(): Promise<{ scored: number }> {
  if (!(await isSuperAdmin())) throw new Error('Not authorized');
  const admin = createServiceClient();
  const scored = await recomputeAllContactScores(admin, 2000);
  revalidatePath('/admin/marketing/lead-scores');
  return { scored };
}
