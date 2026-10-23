'use server';

// Server actions for the AI-first Marketplace (V2): match intelligence
// (dismiss/actioned), saves (♥), store follows, storefront upsert, order
// lifecycle, and two-sided reviews. Everything family-scoped via RLS; an update
// against another family's row is a silent no-op.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { readFamilyOrders } from '@/lib/marketplace/schema-compat';
import { cancelOrderPickup } from '@/lib/marketplace/pickup-server';
import { ORDER_TRANSITIONS, SELLER_ONLY_ORDER_STEPS } from '@/lib/marketplace/order-lifecycle';

type Failure = { ok: false; error: string };
type Result = { ok: true } | Failure;

const MARKETPLACE = '/marketplace';

function actionFailure(operation: string, message: string, error: unknown): Failure {
  console.error(`[marketplace-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

/**
 * A guest views the household (lib/constants/roles.ts: "View the shared
 * calendar, lists and plans"). Opening a storefront, reaching out about a
 * listing and rating an exchange act in the family's name, so they are not a
 * guest's; the screens do not offer them either.
 */
const isGuest = (role: string | null | undefined) => role === 'guest';

/** Set a match's status: dismissed (hide) or actioned (they connected). */
export async function setMatchStatusAction(id: string, status: 'dismissed' | 'actioned'): Promise<Result> {
  const t = await getTranslations();
  if (!id) return { ok: false, error: t('actions.invalidMatch') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data: matched, error } = await supabase
    .from('marketplace_matches')
    .update({ status })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId)
    .select('id');
  if (error) return actionFailure('update the match', t('marketplace.couldNotUpdateTheMatch'), error);
  if (wroteNoRows(matched)) return { ok: false, error: t('marketplace.couldNotUpdateTheMatch') };
  revalidatePath(MARKETPLACE);
  return { ok: true };
}

/** Toggle a ♥ save on a listing for the current member. Returns the new state. */
export async function toggleSaveAction(listingId: string): Promise<Result | { ok: true; saved: boolean }> {
  const t = await getTranslations();
  if (!listingId) return { ok: false, error: t('actions.invalidListing') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const memberId = ctx.active.member.id;

  const { data: existing, error: readError } = await supabase
    .from('marketplace_saves')
    .select('id')
    .eq('listing_id', listingId)
    .eq('member_id', memberId)
    .maybeSingle();

  if (readError) return actionFailure('check the saved listing', t('marketplace.couldNotCheckTheSavedListing'), readError);
  if (existing) {
    // `existing` came from a family-scoped read, so the id is already proven to
    // belong — but the row can be gone by the time this runs, and the caller is
    // told `saved: false` either way. Audit C1-S9-56.
    const { data: unsaved, error } = await supabase.from('marketplace_saves').delete()
      .eq('id', existing.id).eq('family_id', ctx.active.familyId).select('id');
    if (error) return actionFailure('remove the saved listing', t('marketplace.couldNotRemoveTheSavedListing'), error);
    if (wroteNoRows(unsaved)) return { ok: false, error: t('marketplace.couldNotRemoveTheSavedListing') };
    revalidatePath(MARKETPLACE);
    return { ok: true, saved: false };
  }
  const { error } = await supabase.from('marketplace_saves').insert({
    family_id: ctx.active.familyId, listing_id: listingId, member_id: memberId,
  });
  if (error) return actionFailure('save the listing', t('marketplace.couldNotSaveTheListing'), error);
  revalidatePath(MARKETPLACE);
  return { ok: true, saved: true };
}

/** Follow / unfollow a store for the current member. Returns the new state. */
export async function toggleFollowAction(storeId: string): Promise<Result | { ok: true; following: boolean }> {
  const t = await getTranslations();
  if (!storeId) return { ok: false, error: t('actions.invalidStore') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const memberId = ctx.active.member.id;

  const { data: existing, error: readError } = await supabase
    .from('marketplace_follows')
    .select('id')
    .eq('store_id', storeId)
    .eq('member_id', memberId)
    .maybeSingle();

  if (readError) return actionFailure('check the followed store', t('marketplace.couldNotCheckTheFollowedStore'), readError);
  if (existing) {
    const { data: unfollowed, error } = await supabase.from('marketplace_follows').delete()
      .eq('id', existing.id).eq('family_id', ctx.active.familyId).select('id');
    if (error) return actionFailure('unfollow the store', t('marketplace.couldNotUnfollowTheStore'), error);
    if (wroteNoRows(unfollowed)) return { ok: false, error: t('marketplace.couldNotUnfollowTheStore') };
    revalidatePath(MARKETPLACE);
    return { ok: true, following: false };
  }
  const { error } = await supabase.from('marketplace_follows').insert({
    family_id: ctx.active.familyId, store_id: storeId, member_id: memberId,
  });
  if (error) return actionFailure('follow the store', t('marketplace.couldNotFollowTheStore'), error);
  revalidatePath(MARKETPLACE);
  return { ok: true, following: true };
}

/** Create/update the current member's storefront (one per member). */
export async function upsertStoreAction(input: { name: string; tagline?: string; description?: string; emoji?: string }): Promise<Result> {
  const t = await getTranslations();
  const name = input.name?.trim();
  if (!name) return { ok: false, error: t('actions.giveYourStoreAName') };
  const ctx = await requireUserContext();
  if (isGuest(ctx.active.role)) return { ok: false, error: t('actionRefusal.notAllowed') };
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
  if (error) return actionFailure('save the storefront', t('marketplace.couldNotSaveTheStorefront'), error);
  revalidatePath(`${MARKETPLACE}/store`);
  revalidatePath(MARKETPLACE);
  return { ok: true };
}

// The order state machine, in the database's own vocabulary (0151's check on
// marketplace_orders.status). One table: the Orders page offers exactly these
// steps (components/marketplace/order-controls.tsx).
const ORDER_FLOW: Readonly<Record<string, readonly string[]>> = ORDER_TRANSITIONS;

/** Advance an order along its lifecycle (requested→confirmed→active→…). */
export async function setOrderStatusAction(orderId: string, status: string): Promise<Result> {
  const t = await getTranslations();
  if (!orderId) return { ok: false, error: t('actions.invalidOrder') };
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // Either party's family (readFamilyOrders): an order between two households
  // carries the seller's family_id and, after the proposed economy SQL, the
  // buyer's as buyer_family_id.
  const { data: order, error: orderError } = await readFamilyOrders(ctx.active.familyId, (scope) => scope(supabase
    .from('marketplace_orders')
    .select('id, status, family_id, seller_member')
    .eq('id', orderId))
    .maybeSingle());
  if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);
  if (!order) return { ok: false, error: t('actions.orderNotFound') };
  if (!(ORDER_FLOW[order.status] ?? []).includes(status)) {
    // The screen offers only the next steps from the status it shows, so an
    // illegal step means that status is stale (someone else moved the order).
    // Said so in the viewer's language, and without echoing `status`, which the
    // caller supplies. (I18N-002)
    return { ok: false, error: t('marketplace.orderStepNoLongerAvailable') };
  }
  // Returned and complete are the seller's word (the lender's, on a rent or a
  // borrow). RLS lets either party write the row, so this is where it is
  // decided; the Orders page offers those steps to the seller alone.
  if (SELLER_ONLY_ORDER_STEPS.has(status) && order.seller_member !== ctx.active.member.id) {
    return { ok: false, error: t('marketplace.onlyTheSellerFinishesAnOrder') };
  }

  // CLAIM the transition rather than assuming it. The status was validated
  // against `order.status` read a moment ago, and nothing stopped that changing
  // in between: two concurrent calls could both read `requested` and both
  // advance, or advance along divergent branches of ORDER_FLOW. Predicating the
  // update on the status it was validated against makes the check and the write
  // one atomic step — the same fix the allowance claim in wallet/actions.ts
  // already uses to stop a double credit (C1-S9-53).
  //
  // The `family_id` filter is defence in depth: ownership is already proven by
  // the read above and by RLS, but a write that carries its own scope cannot be
  // detached from its guard by a later edit. Audit C1-S9-56. It is the order's
  // own family_id, read above under the caller's either-party scope: for the
  // buyer's household on a cross-family order that is the seller's family.
  const { data: advanced, error } = await supabase.from('marketplace_orders')
    .update({ status })
    .eq('id', orderId)
    .eq('family_id', order.family_id)
    .eq('status', order.status)
    .select('id');
  if (error) return actionFailure('update the order', t('marketplace.couldNotUpdateTheOrder'), error);
  if (wroteNoRows(advanced)) return { ok: false, error: t('actions.orderNotFound') };
  // An order that is off takes its pickup with it. The Orders page stops
  // showing the pickup once the order is cancelled, so nothing else would ever
  // take it — or its family-calendar event — down.
  // The pickup row is the order's family's; a calendar event is in the
  // family of whoever confirmed it, which the caller can only remove from
  // their own (see cancelOrderPickup).
  if (status === 'cancelled') await cancelOrderPickup(supabase, orderId, order.family_id, ctx.active.familyId);
  revalidatePath(`${MARKETPLACE}/orders`);
  return { ok: true };
}

/** Leave a review on a completed order (one per side; both parties can review). */
export async function leaveReviewAction(input: { orderId: string; rating: number; comment?: string }): Promise<Result> {
  const t = await getTranslations();
  const rating = Math.round(input.rating);
  if (!input.orderId || rating < 1 || rating > 5) return { ok: false, error: t('actions.pickARatingFrom1') };
  const ctx = await requireUserContext();
  if (isGuest(ctx.active.role)) return { ok: false, error: t('actionRefusal.notAllowed') };
  const supabase = await createServer();
  const memberId = ctx.active.member.id;

  const { data: order, error: orderError } = await readFamilyOrders(ctx.active.familyId, (scope) => scope(supabase
    .from('marketplace_orders')
    .select('id, family_id, listing_id, buyer_member, seller_member, status')
    .eq('id', input.orderId))
    .maybeSingle());
  if (orderError) return actionFailure('load the order', t('marketplace.couldNotLoadTheOrder'), orderError);
  if (!order) return { ok: false, error: t('actions.orderNotFound') };
  if (order.status !== 'completed') return { ok: false, error: t('actions.reviewsOpenOnceTheExchange') };
  const isBuyer = order.buyer_member === memberId;
  const isSeller = order.seller_member === memberId;
  if (!isBuyer && !isSeller) return { ok: false, error: t('actions.onlyTheTwoPartiesCan') };
  // A review lives in the ORDER's family: marketplace_reviews_insert (0359)
  // requires o.family_id = the review's family_id and the reviewer to be that
  // family's member. An order won at auction, bought outright or agreed in a
  // negotiation is the SELLER's family's, so the buyer from another household
  // can file no review the database will take (they were told "Could not save
  // the review" every time). Said so here, and the Orders page does not offer
  // them the form; accepting their review is the owner's SQL.
  if (order.family_id !== ctx.active.familyId) return { ok: false, error: t('marketplace.reviewsAcrossHouseholdsAreNotOpenYet') };

  const { error } = await supabase.from('marketplace_reviews').insert({
    family_id: order.family_id,
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
      return { ok: false, error: t('actions.youAlreadyReviewedThisExchange') };
    }
    return actionFailure('save the review', t('marketplace.couldNotSaveTheReview'), error);
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
  const t = await getTranslations();
  if (!listingId) return { ok: false, error: t('actions.invalidListing') };
  const ctx = await requireUserContext();
  if (isGuest(ctx.active.role)) return { ok: false, error: t('actionRefusal.notAllowed') };
  const supabase = await createServer();
  const memberId = ctx.active.member.id;

  const { data: listing, error: listingError } = await supabase
    .from('marketplace_listings')
    .select('id, kind, status, member_id, sale_format, price_cents')
    .eq('id', listingId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();
  if (listingError) return actionFailure('load the listing', t('marketplace.couldNotLoadTheListing'), listingError);
  if (!listing) return { ok: false, error: t('actions.listingNotFound') };
  if (listing.member_id === memberId) return { ok: false, error: t('actions.thisIsYourOwnListing') };
  // An auction takes bids, not interest. The offer's trigger (0154) flips an
  // available listing to 'pending', which every bid, Buy-It-Now and the close
  // then refuse: one "I'm interested" froze the auction, with no way back from
  // the board, and accepting it sold the item at its price under live bids.
  if (listing.sale_format === 'auction') return { ok: false, error: t('marketplace.anAuctionTakesBidsNotInterest') };
  if (listing.status !== 'available' && listing.status !== 'pending') {
    return { ok: false, error: t('actions.thisListingIsNoLonger') };
  }

  const { data: existing, error: offerError } = await supabase
    .from('marketplace_offers')
    .select('id')
    .eq('listing_id', listingId)
    .eq('member_id', memberId)
    .eq('status', 'open')
    .maybeSingle();
  if (offerError) return actionFailure('check existing offers', t('marketplace.couldNotCheckExistingOffers'), offerError);
  if (existing) return { ok: false, error: t('actions.youAlreadyReachedOutAbout') };

  // A DB trigger flips an available listing to 'pending' on insert; a partial
  // unique index (listing_id, member_id where status='open') makes a racing
  // duplicate a caught 23505 rather than a second open offer.
  const kind = listing.kind === 'sell' || listing.kind === 'rent' ? 'interest' : 'claim';
  // An interest carries the price it was given at. Accepting records the order
  // at `coalesce(offer.amount_cents, listing.price_cents)` (0315), so an offer
  // with no amount was accepted at whatever the listing said by then: a price
  // the seller changed after the interest, and the buyer never saw.
  const { error } = await supabase.from('marketplace_offers').insert({
    family_id: ctx.active.familyId, listing_id: listingId, member_id: memberId, kind, created_by: ctx.user.id,
    amount_cents: kind === 'interest' ? listing.price_cents : null,
  });
  if (error) {
    if (error.code === '23505') return { ok: false, error: t('actions.youAlreadyReachedOutAbout') };
    return actionFailure('send the offer', t('marketplace.couldNotSendTheOffer'), error);
  }

  revalidatePath(`${MARKETPLACE}/item/${listingId}`);
  revalidatePath(`${MARKETPLACE}/browse`);
  return { ok: true };
}

// ── The rail's Trust Score card ──────────────────────────────────────────────

export type TrustScoreInputsResult =
  | { ok: true; memberId: string; ratingsReceived: number[]; ordersCompleted: number; listingsPosted: number }
  | Failure;

/**
 * What the Trust Score card scores for the active member: the ratings they
 * received, the exchanges they completed on either side, and the listings they
 * posted (components/marketplace/sidebar-trust-score.tsx runs the pure engine
 * on these).
 *
 * Read here and not in the browser. The order read asks for buyer_family_id,
 * and a database without the proposed economy SQL answers that with a 400
 * before readFamilyOrders falls back to the seller-family read. On the server
 * that 400 is a response to a fetch, handled and warned about once. In the
 * browser Chromium also prints "Failed to load resource: the server responded
 * with a status of 400" to the console — and the rail is on every marketplace
 * page, so that one probe put a console error on all of them.
 */
export async function readTrustScoreInputsAction(): Promise<TrustScoreInputsResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const memberId = ctx.active.member.id;

  const [reviews, orders, listings] = await settleAll([
    // Every rating, paged on id: an unbounded read stops at db-max-rows (1,000)
    // and says nothing, so the score was over a sample of them.
    readAllByIdAsQuery<{ id: string; rating: number }>((after, limit) => {
      let q = supabase.from('marketplace_reviews').select('id, rating').eq('family_id', familyId).eq('reviewee_member', memberId);
      if (after) q = q.gt('id', after);
      return q.order('id').limit(limit);
    }, { max: 50_000 }),
    // Either party's family, so an exchange this member won from another
    // household counts too (lib/marketplace/schema-compat.ts). Counted by the
    // database, on this member's side of each order: the family's whole order
    // list, filtered here, was the first 1,000 of them.
    //
    // A GET with one row, not a HEAD. A HEAD answer has no body, so the 400 a
    // database without buyer_family_id sends reaches postgrest-js as
    // `{ message: '' }` with no 42703 in it, readFamilyOrders cannot tell it
    // is the missing column, and the rail failed on every marketplace page
    // instead of falling back. Only the count is read.
    readFamilyOrders(familyId, (scope) => scope(supabase.from('marketplace_orders').select('id', { count: 'exact' }))
      .eq('status', 'completed')
      .or(`buyer_member.eq.${memberId},seller_member.eq.${memberId}`)
      .limit(1)),
    supabase.from('marketplace_listings').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('member_id', memberId),
  ]);
  // A failed read is said, not scored: a zero baseline is a real-looking number
  // the family would take as their standing.
  const failure = reviews.error ?? orders.error ?? listings.error;
  if (failure) return actionFailure('read the trust score', t('sidebarTrustScore.couldNotLoad'), failure);

  return {
    ok: true,
    memberId,
    ratingsReceived: (reviews.data ?? []).map((r) => r.rating),
    ordersCompleted: orders.count ?? 0,
    listingsPosted: listings.count ?? 0,
  };
}
