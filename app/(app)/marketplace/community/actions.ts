'use server';

// Community Marketplace circles — server actions (backlog #21 v1). Lifecycle
// (create/join/leave) goes through the ownership-checked SECURITY DEFINER RPCs
// from migration 0176; share/unshare ride plain RLS (a family may only share
// its OWN listings into circles it belongs to). All family-scoped via ctx.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isValidJoinCode, normalizeJoinCode } from '@/lib/marketplace/community';

const PATH = '/marketplace/community';

type Result = { ok: true; id?: string } | { ok: false; error: string };

export async function createCircleAction(name: string, emoji?: string): Promise<Result> {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) return { ok: false, error: 'Give your circle a name' };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { data, error } = await sb.rpc('marketplace_create_circle', {
    p_family: ctx.active.familyId, p_name: trimmed, p_emoji: (emoji ?? '').trim().slice(0, 8) || undefined,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true, id: data ?? undefined };
}

export async function joinCircleAction(code: string): Promise<Result> {
  if (!isValidJoinCode(code)) return { ok: false, error: 'That code doesn’t look complete — it has 8 characters' };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { data, error } = await sb.rpc('marketplace_join_circle', {
    p_family: ctx.active.familyId, p_code: normalizeJoinCode(code),
  });
  if (error) {
    const msg = /no circle/i.test(error.message) ? 'No circle found with that code — double-check it' : error.message;
    return { ok: false, error: msg };
  }
  revalidatePath(PATH);
  return { ok: true, id: data ?? undefined };
}

export async function leaveCircleAction(circleId: string): Promise<Result> {
  if (!circleId) return { ok: false, error: 'Invalid circle' };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { error } = await sb.rpc('marketplace_leave_circle', {
    p_family: ctx.active.familyId, p_circle: circleId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export async function shareListingAction(listingId: string, circleId: string): Promise<Result> {
  if (!listingId || !circleId) return { ok: false, error: 'Invalid share' };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { error } = await sb.from('marketplace_listing_shares').insert({
    listing_id: listingId, circle_id: circleId, family_id: ctx.active.familyId, created_by: ctx.user.id,
  });
  // The unique(listing, circle) constraint makes a double-share idempotent.
  if (error && !/duplicate key/i.test(error.message)) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export async function unshareListingAction(listingId: string, circleId: string): Promise<Result> {
  if (!listingId || !circleId) return { ok: false, error: 'Invalid share' };
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { error } = await sb.from('marketplace_listing_shares')
    .delete()
    .eq('listing_id', listingId)
    .eq('circle_id', circleId)
    .eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}
