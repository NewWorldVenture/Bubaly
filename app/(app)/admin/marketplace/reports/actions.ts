'use server';

// Super-admin moderation actions for marketplace safety reports. Gated by
// isSuperAdmin and executed with the service role (marketplace_reports has no
// public UPDATE policy). Resolving can optionally withdraw the offending
// listing in the same step.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };
type AdminClient = ReturnType<typeof createServiceClient>;
type AuthUser = NonNullable<Awaited<ReturnType<typeof getUser>>>;
type GuardResult = { admin: AdminClient; user: AuthUser } | { ok: false; error: string };

// The fallback is a PARAMETER now, not a default. A default is evaluated in
// the function's own scope, where the request translator cannot be — the lift
// put `t(...)` there and tsc said `Cannot find name 't'`. Every call site
// names its own message, which is also the only way each one can say what
// actually failed.
function actionFailure(error: unknown, fallback: string): Result {
  console.error('[admin-marketplace-report] failed:', error);
  return { ok: false, error: describeActionError(error, fallback) };
}

async function guard(): Promise<GuardResult> {
  const t = await getTranslations();
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) return { ok: false, error: t('actions.notAuthorized') };
  return { admin: createServiceClient(), user };
}

/** Resolve a report: 'actioned' or 'dismissed', with an optional note and an
 *  optional withdrawal of the reported listing. */
export async function resolveReportAction(
  input: { id: string; status: 'actioned' | 'dismissed'; resolution?: string; withdrawListing?: boolean },
): Promise<Result> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('admin' in guarded)) return guarded;
  const id = input?.id?.trim();
  if (!id || !['actioned', 'dismissed'].includes(input.status)) {
    return { ok: false, error: t('actions.invalidResolution') };
  }

  const { data: report, error: reportError } = await guarded.admin
    .from('marketplace_reports').select('id, listing_id, status').eq('id', id).maybeSingle();
  if (reportError) return actionFailure(reportError, t('actions.couldNotLoadThatReport'));
  if (!report) return { ok: false, error: t('actions.reportNotFound') };

  // Withdraw first so a failed safety write leaves the report open for retry.
  if (input.status === 'actioned' && input.withdrawListing && report.listing_id) {
    const { data: listing, error: listingError } = await guarded.admin
      .from('marketplace_listings').select('id, status').eq('id', report.listing_id).maybeSingle();
    if (listingError) return actionFailure(listingError, t('actions.couldNotLoadTheReported'));
    if (!listing) return { ok: false, error: t('actions.reportedListingNotFound') };
    if (['available', 'pending'].includes(listing.status)) {
      const { data: withdrawn, error: withdrawalError } = await guarded.admin
        .from('marketplace_listings').update({ status: 'withdrawn' })
        .eq('id', report.listing_id).in('status', ['available', 'pending']).select('id').maybeSingle();
      if (withdrawalError) return actionFailure(withdrawalError, t('actions.couldNotWithdrawTheReported'));
      if (!withdrawn) return { ok: false, error: t('actions.theReportedListingChangedBefore') };
    }
  }

  const { data: updated, error } = await guarded.admin.from('marketplace_reports').update({
    status: input.status, resolution: input.resolution?.trim().slice(0, 1000) || null,
    reviewed_by: guarded.user.id, reviewed_at: new Date().toISOString(),
  }).eq('id', id).in('status', ['open', 'reviewing']).select('id').maybeSingle();
  if (error) return actionFailure(error, t('actions.couldNotUpdateThatReport'));
  if (!updated) return { ok: false, error: t('actions.reportNotFoundOrAlready') };

  revalidatePath('/admin/marketplace/reports');
  return { ok: true };
}

/** Move an open report into 'reviewing' (claim it). */
export async function startReviewAction(id: string): Promise<Result> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('admin' in guarded)) return guarded;
  const reportId = id.trim();
  if (!reportId) return { ok: false, error: t('actions.aReportIsRequired') };
  const { data, error } = await guarded.admin.from('marketplace_reports')
    .update({ status: 'reviewing', reviewed_by: guarded.user.id }).eq('id', reportId).eq('status', 'open')
    .select('id').maybeSingle();
  if (error) return actionFailure(error, t('actions.couldNotStartThatReview'));
  if (!data) return { ok: false, error: t('actions.reportNotFoundOrAlready2') };
  revalidatePath('/admin/marketplace/reports');
  return { ok: true };
}
