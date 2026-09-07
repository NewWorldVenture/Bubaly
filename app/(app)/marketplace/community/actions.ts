'use server';

// Community Marketplace circles — server actions (backlog #21 v1). Lifecycle
// (create/join/leave) goes through the ownership-checked SECURITY DEFINER RPCs
// from migration 0176; share/unshare ride plain RLS (a family may only share
// its OWN listings into circles it belongs to). All family-scoped via ctx.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isValidJoinCode, normalizeJoinCode } from '@/lib/marketplace/community';
import { describeActionError } from '@/lib/supabase/errors';

const PATH = '/marketplace/community';

type Result = { ok: true; id?: string } | { ok: false; error: string };

function actionFailure(operation: string, error: unknown): Result {
  console.error(`[marketplace-community] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

export async function createCircleAction(name: string, emoji?: string): Promise<Result> {
  const t = await getTranslations();
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) return { ok: false, error: t('actions.giveYourCircleAName') };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { data, error } = await sb.rpc('marketplace_create_circle', {
    p_family: ctx.active.familyId, p_name: trimmed, p_emoji: (emoji ?? '').trim().slice(0, 8) || undefined,
  });
  if (error) return actionFailure('create the circle', error);
  revalidatePath(PATH);
  return { ok: true, id: data ?? undefined };
}

export async function joinCircleAction(code: string): Promise<Result> {
  const t = await getTranslations();
  if (!isValidJoinCode(code)) return { ok: false, error: t('actions.thatCodeDoesnTLook') };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { data, error } = await sb.rpc('marketplace_join_circle', {
    p_family: ctx.active.familyId, p_code: normalizeJoinCode(code),
  });
  if (error) {
    if (/no circle/i.test(error.message)) return { ok: false, error: t('actions.noCircleFoundWithThat') };
    return actionFailure('join the circle', error);
  }
  revalidatePath(PATH);
  return { ok: true, id: data ?? undefined };
}

export async function leaveCircleAction(circleId: string): Promise<Result> {
  const t = await getTranslations();
  if (!circleId) return { ok: false, error: t('actions.invalidCircle') };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { error } = await sb.rpc('marketplace_leave_circle', {
    p_family: ctx.active.familyId, p_circle: circleId,
  });
  if (error) return actionFailure('leave the circle', error);
  revalidatePath(PATH);
  return { ok: true };
}

export async function shareListingAction(listingId: string, circleId: string): Promise<Result> {
  const t = await getTranslations();
  if (!listingId || !circleId) return { ok: false, error: t('actions.invalidShare') };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { error } = await sb.from('marketplace_listing_shares').insert({
    listing_id: listingId, circle_id: circleId, family_id: ctx.active.familyId, created_by: ctx.user.id,
  });
  // The unique(listing, circle) constraint makes a double-share idempotent.
  if (error && error.code !== '23505' && !/duplicate key/i.test(error.message)) return actionFailure('share the listing', error);
  revalidatePath(PATH);
  return { ok: true };
}

export async function unshareListingAction(listingId: string, circleId: string): Promise<Result> {
  const t = await getTranslations();
  if (!listingId || !circleId) return { ok: false, error: t('actions.invalidShare') };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { error } = await sb.from('marketplace_listing_shares')
    .delete()
    .eq('listing_id', listingId)
    .eq('circle_id', circleId)
    .eq('family_id', ctx.active.familyId);
  if (error) return actionFailure('remove the shared listing', error);
  revalidatePath(PATH);
  return { ok: true };
}
