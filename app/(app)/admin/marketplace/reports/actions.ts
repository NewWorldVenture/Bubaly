'use server';

// Super-admin moderation actions for marketplace safety reports. Gated by
// isSuperAdmin and executed with the service role (marketplace_reports has no
// public UPDATE policy). Resolving can optionally withdraw the offending
// listing in the same step.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { superAdminAssurance } from '@/lib/auth/super-admin-assurance';
import { createServiceClient } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import { logAudit } from '@/lib/server/audit';

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
  if (!(await superAdminAssurance()).ok) return { ok: false, error: t('actions.adminConsoleNeedsYourCode') };
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
  // A report another admin already resolved (or a stale screen) is refused
  // BEFORE anything is written. Without this the withdrawal below ran, the
  // conditional report update then matched nothing, and the admin was told it
  // failed while the seller's listing stayed withdrawn with no record.
  if (!['open', 'reviewing'].includes(report.status)) return { ok: false, error: t('actions.reportNotFoundOrAlready') };

  // Withdraw first so a failed safety write leaves the report open for retry.
  let withdrewFrom: string | null = null;
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
      withdrewFrom = listing.status;
    }
  }

  const { data: updated, error } = await guarded.admin.from('marketplace_reports').update({
    status: input.status, resolution: input.resolution?.trim().slice(0, 1000) || null,
    reviewed_by: guarded.user.id, reviewed_at: new Date().toISOString(),
  }).eq('id', id).in('status', ['open', 'reviewing']).select('id').maybeSingle();
  if (error || !updated) {
    // The report did not move (a concurrent resolve won between the check and
    // here, or the write failed), so the withdrawal made for it is put back
    // rather than left standing with nothing recording why.
    if (withdrewFrom && report.listing_id) {
      const { data: restored, error: restoreError } = await guarded.admin
        .from('marketplace_listings').update({ status: withdrewFrom })
        .eq('id', report.listing_id).eq('status', 'withdrawn').select('id').maybeSingle();
      if (restoreError || !restored) {
        console.error('[admin-marketplace-report] could not restore the withdrawn listing', restoreError ?? report.listing_id);
        // The listing stays withdrawn with its report unresolved, so the
        // withdrawal is recorded here: otherwise nothing says who or why.
        await logAudit(guarded.admin, {
          familyId: null, actorId: guarded.user.id, action: 'withdraw', resource: 'marketplace_listings',
          resourceId: report.listing_id,
          metadata: { report_id: id, previous_status: withdrewFrom, restore_failed: true, via: 'site_admin' },
        });
      }
    }
    if (error) return actionFailure(error, t('actions.couldNotUpdateThatReport'));
    return { ok: false, error: t('actions.reportNotFoundOrAlready') };
  }

  if (withdrewFrom && report.listing_id) {
    await logAudit(guarded.admin, {
      familyId: null, actorId: guarded.user.id, action: 'withdraw', resource: 'marketplace_listings',
      resourceId: report.listing_id, metadata: { report_id: id, previous_status: withdrewFrom, via: 'site_admin' },
    });
  }
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
