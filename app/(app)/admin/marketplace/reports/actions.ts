'use server';

// Super-admin moderation actions for marketplace safety reports. Gated by
// isSuperAdmin and executed with the service role (marketplace_reports has no
// public UPDATE policy). Resolving can optionally withdraw the offending
// listing in the same step.
import { revalidatePath } from 'next/cache';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };

function actionFailure(error: unknown, fallback = 'Could not update that report.'): Result {
  console.error('[admin-marketplace-report] failed:', error);
  return { ok: false, error: describeActionError(error, fallback) };
}

async function guard() {
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) throw new Error('Forbidden: admin only');
  return { admin: createServiceClient(), user };
}

/** Resolve a report: 'actioned' or 'dismissed', with an optional note and an
 *  optional withdrawal of the reported listing. */
export async function resolveReportAction(
  input: { id: string; status: 'actioned' | 'dismissed'; resolution?: string; withdrawListing?: boolean },
): Promise<Result> {
  const { admin, user } = await guard();
  if (!input.id || !['actioned', 'dismissed'].includes(input.status)) {
    return { ok: false, error: 'Invalid resolution.' };
  }

  const { data: report } = await admin
    .from('marketplace_reports').select('id, listing_id, status').eq('id', input.id).maybeSingle();
  if (!report) return { ok: false, error: 'Report not found.' };

  const { error } = await admin.from('marketplace_reports').update({
    status: input.status, resolution: input.resolution?.trim() || null,
    reviewed_by: user.id, reviewed_at: new Date().toISOString(),
  }).eq('id', input.id);
  if (error) return actionFailure(error);

  // Actioning a real problem can pull the listing immediately.
  if (input.status === 'actioned' && input.withdrawListing && report.listing_id) {
    await admin.from('marketplace_listings').update({ status: 'withdrawn' })
      .eq('id', report.listing_id).in('status', ['available', 'pending']);
  }

  revalidatePath('/admin/marketplace/reports');
  return { ok: true };
}

/** Move an open report into 'reviewing' (claim it). */
export async function startReviewAction(id: string): Promise<Result> {
  const { admin, user } = await guard();
  const { error } = await admin.from('marketplace_reports')
    .update({ status: 'reviewing', reviewed_by: user.id }).eq('id', id).eq('status', 'open');
  if (error) return actionFailure(error, 'Could not start that review.');
  revalidatePath('/admin/marketplace/reports');
  return { ok: true };
}
