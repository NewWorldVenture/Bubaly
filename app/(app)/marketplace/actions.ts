'use server';

// Server actions for the AI-first Marketplace (V2): match intelligence
// (dismiss/actioned), saves (♥), store follows, storefront upsert, order
// lifecycle, and two-sided reviews. Everything family-scoped via RLS; an update
// against another family's row is a silent no-op.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };

const MARKETPLACE = '/marketplace';

function actionFailure(operation: string, error: unknown): Result {
  console.error(`[marketplace-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

/** Set a match's status: dismissed (hide) or actioned (they connected). */
export async function setMatchStatusAction(id: string, status: 'dismissed' | 'actioned'): Promise<Result> {
  if (!id) return { ok: false, error: 'Invalid match' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase
    .from('marketplace_matches')
    .update({ status })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId);
  if (error) return actionFailure('update the match', error);
  revalidatePath(MARKETPLACE);
  return { ok: true };
}

/** Toggle a ♥ save on a listing for the current member. Returns the new state. */
export async function toggleSaveAction(listingId: string): Promise<Result | { ok: true; saved: boolean }> {
  if (!listingId) return { ok: false, error: 'Invalid listing' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const memberId = ctx.active.member.id;

  const { data: existing, error: readError } = await supabase
    .from('marketplace_saves')
    .select('id')
    .eq('listing_id', listingId)
    .eq('member_id', memberId)
    .maybeSingle();

  if (readError) return actionFailure('check the saved listing', readError);
  if (existing) {
    const { error } = await supabase.from('marketplace_saves').delete().eq('id', existing.id);
    if (error) return actionFailure('remove the saved listing', error);
    revalidatePath(MARKETPLACE);
    return { ok: true, saved: false };
  }
  const { error } = await supabase.from('marketplace_saves').insert({
    family_id: ctx.active.familyId, listing_id: listingId, member_id: memberId,
  });
  if (error) return actionFailure('save the listing', error);
  revalidatePath(MARKETPLACE);
  return { ok: true, saved: true };
}

/** Follow / unfollow a store for the current member. Returns the new state. */
export async function toggleFollowAction(storeId: string): Promise<Result | { ok: true; following: boolean }> {
  if (!storeId) return { ok: false, error: 'Invalid store' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const memberId = ctx.active.member.id;

  const { data: existing, error: readError } = await supabase
    .from('marketplace_follows')
    .select('id')
    .eq('store_id', storeId)
    .eq('member_id', memberId)
    .maybeSingle();

  if (readError) return actionFailure('check the followed store', readError);
  if (existing) {
    const { error } = await supabase.from('marketplace_follows').delete().eq('id', existing.id);
    if (error) return actionFailure('unfollow the store', error);
    revalidatePath(MARKETPLACE);
    return { ok: true, following: false };
  }
  const { error } = await supabase.from('marketplace_follows').insert({
    family_id: ctx.active.familyId, store_id: storeId, member_id: memberId,
  });
  if (error) return actionFailure('follow the store', error);
  revalidatePath(MARKETPLACE);
  return { ok: true, following: true };
}

/** Create/update the current member's storefront (one per member). */
export async function upsertStoreAction(input: { name: string; tagline?: string; description?: string; emoji?: string }): Promise<Result> {
  const name = input.name?.trim();
  if (!name) return { ok: false, error: 'Give your store a name' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('marketplace_stores').upsert({
    family_id: ctx.active.familyId,
    member_id: ctx.active.member.id,
    name,
    tagline: input.tagline?.trim() || null,
    description: input.description?.trim() || null,
    emoji: input.emoji?.trim() || null,
    is_active: true,
    created_by: ctx.user.id,
  }, { onConflict: 'family_id,member_id' });
  if (error) return actionFailure('save the storefront', error);
  revalidatePath(`${MARKETPLACE}/store`);
  revalidatePath(MARKETPLACE);
  return { ok: true };
}

const ORDER_FLOW: Record<string, string[]> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['active', 'cancelled'],
  active: ['returned', 'completed'],
  returned: ['completed'],
};

/** Advance an order along its lifecycle (requested→confirmed→active→…). */
export async function setOrderStatusAction(orderId: string, status: string): Promise<Result> {
  if (!orderId) return { ok: false, error: 'Invalid order' };
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data: order, error: orderError } = await supabase
    .from('marketplace_orders')
    .select('id, status')
    .eq('id', orderId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();
  if (orderError) return actionFailure('load the order', orderError);
  if (!order) return { ok: false, error: 'Order not found' };
  if (!(ORDER_FLOW[order.status] ?? []).includes(status)) {
    return { ok: false, error: `Can’t go from ${order.status} to ${status}` };
  }

  const { error } = await supabase.from('marketplace_orders').update({ status }).eq('id', orderId);
  if (error) return actionFailure('update the order', error);
  revalidatePath(`${MARKETPLACE}/orders`);
  return { ok: true };
}

/** Leave a review on a completed order (one per side; both parties can review). */
export async function leaveReviewAction(input: { orderId: string; rating: number; comment?: string }): Promise<Result> {
  const rating = Math.round(input.rating);
  if (!input.orderId || rating < 1 || rating > 5) return { ok: false, error: 'Pick a rating from 1 to 5' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const memberId = ctx.active.member.id;

  const { data: order, error: orderError } = await supabase
    .from('marketplace_orders')
    .select('id, listing_id, buyer_member, seller_member, status')
    .eq('id', input.orderId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();
  if (orderError) return actionFailure('load the order', orderError);
  if (!order) return { ok: false, error: 'Order not found' };
  if (order.status !== 'completed') return { ok: false, error: 'Reviews open once the exchange completes' };
  const isBuyer = order.buyer_member === memberId;
  const isSeller = order.seller_member === memberId;
  if (!isBuyer && !isSeller) return { ok: false, error: 'Only the two parties can review this exchange' };

  const { error } = await supabase.from('marketplace_reviews').insert({
    family_id: ctx.active.familyId,
    order_id: order.id,
    listing_id: order.listing_id,
    reviewer_member: memberId,
    reviewee_member: isBuyer ? order.seller_member : order.buyer_member,
    role: isBuyer ? 'buyer' : 'seller',
    rating,
    comment: input.comment?.trim() || null,
    created_by: ctx.user.id,
  });
  if (error) {
    if (error.message.includes('uq_marketplace_reviews_order_side') || error.code === '23505') {
      return { ok: false, error: 'You already reviewed this exchange' };
    }
    return actionFailure('save the review', error);
  }
  revalidatePath(`${MARKETPLACE}/reviews`);
  revalidatePath(`${MARKETPLACE}/orders`);
  return { ok: true };
}

/**
 * Express interest ('interest') or claim ('claim') on a listing from its detail
 * page. Guards: the listing must be browsable and not the member's own, and they
 * mustn't already have an open offer on it. Flips an available listing to
 * 'pending' so others see it's being discussed. Family-scoped via RLS.
 */
export async function makeOfferAction(listingId: string): Promise<Result> {
  if (!listingId) return { ok: false, error: 'Invalid listing' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const memberId = ctx.active.member.id;

  const { data: listing, error: listingError } = await supabase
    .from('marketplace_listings')
    .select('id, kind, status, member_id')
    .eq('id', listingId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();
  if (listingError) return actionFailure('load the listing', listingError);
  if (!listing) return { ok: false, error: 'Listing not found' };
  if (listing.member_id === memberId) return { ok: false, error: 'This is your own listing' };
  if (listing.status !== 'available' && listing.status !== 'pending') {
    return { ok: false, error: 'This listing is no longer open' };
  }

  const { data: existing, error: offerError } = await supabase
    .from('marketplace_offers')
    .select('id')
    .eq('listing_id', listingId)
    .eq('member_id', memberId)
    .eq('status', 'open')
    .maybeSingle();
  if (offerError) return actionFailure('check existing offers', offerError);
  if (existing) return { ok: false, error: 'You already reached out about this' };

  // A DB trigger flips an available listing to 'pending' on insert; a partial
  // unique index (listing_id, member_id where status='open') makes a racing
  // duplicate a caught 23505 rather than a second open offer.
  const kind = listing.kind === 'sell' || listing.kind === 'rent' ? 'interest' : 'claim';
  const { error } = await supabase.from('marketplace_offers').insert({
    family_id: ctx.active.familyId, listing_id: listingId, member_id: memberId, kind, created_by: ctx.user.id,
  });
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'You already reached out about this' };
    return actionFailure('send the offer', error);
  }

  revalidatePath(`${MARKETPLACE}/item/${listingId}`);
  revalidatePath(`${MARKETPLACE}/browse`);
  return { ok: true };
}
