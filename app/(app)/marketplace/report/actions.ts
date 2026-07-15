'use server';

// Report a listing to the platform safety queue. Family-scoped via
// requireUserContext + RLS on marketplace_reports; a partial unique index keeps
// a member from stacking open reports on the same listing. Resolutions are
// written only by the super-admin (service role) — never here.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { isValidReason, canReport } from '@/lib/marketplace/reports';
import { recordAdminNotification } from '@/lib/admin/notify';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };

function actionFailure(operation: string, error: unknown): Result {
  console.error(`[marketplace-report] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

export async function reportListingAction(
  input: { listingId: string; reason: string; details?: string },
): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  if (!input.listingId) return { ok: false, error: 'Invalid listing.' };
  if (!isValidReason(input.reason)) return { ok: false, error: 'Pick a reason.' };
  const details = input.details?.trim() || null;
  if (details && details.length > 1000) return { ok: false, error: 'Keep the details under 1000 characters.' };

  // The listing must exist + be reachable; can't report your own.
  const { data: listing } = await supabase
    .from('marketplace_listings').select('id, member_id').eq('id', input.listingId).maybeSingle();
  if (!listing) return { ok: false, error: 'That listing no longer exists.' };
  if (!canReport(listing.member_id, ctx.active.member.id)) {
    return { ok: false, error: 'You can’t report your own family’s listing.' };
  }

  const { error } = await supabase.from('marketplace_reports').insert({
    family_id: ctx.active.familyId, listing_id: input.listingId,
    reporter_member: ctx.active.member.id, reason: input.reason, details,
  });
  if (error) {
    // Unique violation → they already have an open report on this listing.
    if (error.code === '23505') return { ok: false, error: 'You’ve already reported this — our team is on it.' };
    return actionFailure('submit the report', error);
  }

  // Alert the super admin's Trust & Safety queue (service role — admin_notifications
  // has no client policy). Best-effort; the report already saved.
  await recordAdminNotification(createServiceClient(), {
    kind: 'marketplace_report',
    title: 'New marketplace report',
    body: `Reason: ${input.reason}${details ? ` — ${details.slice(0, 160)}` : ''}`,
    url: '/admin/marketplace/reports',
    relatedType: 'marketplace_report',
  });

  revalidatePath(`/marketplace/item/${input.listingId}`);
  return { ok: true };
}
