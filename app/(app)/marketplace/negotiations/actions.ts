'use server';

// "Make an Offer" negotiation server actions. Buyers open/counter via
// marketplace_negotiation_offer; either party counters/accepts/declines/
// withdraws via marketplace_negotiation_respond. Both RPCs are SECURITY DEFINER
// and row-lock the listing, verifying the caller is the buyer (in their family)
// or the listing owner (in theirs) — so a race can't hand the same item to two
// buyers. Reads stay under RLS.
//
// Every negotiation is between two households: 0187's
// marketplace_negotiations_distinct_families is `check (family_id <>
// buyer_family_id)`, and the offer RPC refuses own_listing. So opening an
// offer, countering and accepting are each a deal with another family's adult
// (an accepted thread becomes a confirmed order and a pickup), and a child or
// teen is refused all three here. Declining and withdrawing only end a thread
// and stay open to every party.
//
// For the same reason, none of the three is made with a household that has
// closed its account (lib/marketplace/seller-standing.ts): it cannot see the
// thread or the order, and every delivery cron skips its notices, so the
// other family would wait on someone who hears nothing — as a bid or a
// Buy-It-Now on a closed seller's listing is refused in auctions/actions.ts.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { readBidTarget } from '@/lib/marketplace/circle-reads';
import { eitherPartyFamily } from '@/lib/marketplace/schema-compat';
import { readFamilyStanding, readSellerStanding } from '@/lib/marketplace/seller-standing';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const OFFER_REASON: Record<string, string> = {
  bad_amount: 'actions.enterAnAmountAbove0',
  message_too_long: 'actions.keepTheNoteUnder500',
  not_found: 'actions.thatListingNoLongerExists',
  not_negotiable: 'actions.thisListingDoesnTTake',
  not_available: 'actions.thisListingIsNoLongerAvailable',
  not_authorized: 'actions.youReNotAbleTo',
  own_listing: 'actions.youCanTMakeAn',
  at_or_above_ask: 'actions.thatSAtOrAbove',
  not_your_turn: 'actions.itSTheOtherSide',
};

const RESPOND_REASON: Record<string, string> = {
  not_found: 'actions.thatNegotiationNoLongerExists',
  message_too_long: 'actions.keepTheNoteUnder500',
  at_or_above_ask: 'actions.thatOfferIsAtOr',
  listing_missing: 'actions.theListingNoLongerExists',
  not_open: 'actions.thisNegotiationHasAlreadyClosed',
  not_authorized: 'actions.youReNotPartOf',
  not_your_turn: 'actions.itSTheOtherSide',
  buyer_only: 'actions.onlyTheBuyerCanWithdraw',
  seller_only: 'actions.onlyTheSellerCanDecline',
  not_available: 'actions.theListingIsNoLonger',
  bad_amount: 'actions.enterAnAmountAbove0',
  bad_action: 'actions.thatActionIsnTValid',
};

/**
 * The offer RPC locks the listing and then the thread; the respond RPC locks
 * the thread and then the listing (0483). A buyer's counter crossing the
 * seller's decline on one thread can therefore deadlock, and Postgres aborts
 * one of the two with 40P01 (a serialization failure, 40001, is the same
 * story). Nothing was written and a retry succeeds, so that is what the person
 * is told, instead of the generic "could not". Ordering the locks the same
 * way in both functions is the owner's SQL.
 */
const CROSSED_ANOTHER_MOVE = new Set(['40P01', '40001']);

function actionFailure(operation: string, message: string, error: unknown, t: (key: string) => string): Result {
  console.error(`[marketplace-negotiations] ${operation} failed`, error);
  const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? '') : '';
  if (CROSSED_ANOTHER_MOVE.has(code)) return { ok: false, error: t('negotiations.theOtherSideActedAtTheSameMoment') };
  return { ok: false, error: describeActionError(error, message) };
}

function revalidate(listingId?: string) {
  if (listingId) revalidatePath(`/marketplace/item/${listingId}`);
  revalidatePath('/marketplace/negotiations');
}

/** Buyer opens a new negotiation, or counters the seller's last move. */
export async function makeOfferAction(
  input: { listingId: string; amountCents: number; message?: string },
): Promise<Result<{ negotiationId: string; countered: boolean }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  // An offer is made to another household (see the header), and the seller
  // accepting it turns this child's or teen's offer into a confirmed order.
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentGuardianCan16') };
  const supabase = await createServer();
  const amount = Math.round(input.amountCents);
  if (!input.listingId || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: t('actions.enterAValidOfferAmount') };
  }
  const message = input.message?.trim() || null;
  if (message && message.length > 500) return { ok: false, error: t('actions.keepTheNoteUnder500') };

  // The seller's standing is asked only about a listing the buyer's own
  // session can see (readBidTarget: the table, or the circle view), so the
  // answer says nothing about one they cannot; an unseen listing is left to
  // the RPC's not_found.
  const { data: listing, error: listingError } = await readBidTarget(supabase, input.listingId);
  if (listingError) return actionFailure('read the listing before the offer', t('marketplace.couldNotSendTheOffer'), listingError);
  if (listing) {
    const seller = await readSellerStanding(createServiceClient(), input.listingId);
    if (seller === 'unknown') return { ok: false, error: t('marketplace.couldNotSendTheOffer') };
    if (seller === 'closed') return { ok: false, error: t('actions.thisFamilyHasClosedItsAccount') };
  }

  const { data, error } = await supabase.rpc('marketplace_negotiation_offer', {
    p_listing: input.listingId,
    p_buyer_member: ctx.active.member.id,
    p_buyer_family: ctx.active.familyId,
    p_amount: amount,
    p_message: message,
  });
  if (error) return actionFailure('send the offer', t('marketplace.couldNotSendTheOffer'), error, t);

  const res = (data ?? {}) as { ok?: boolean; reason?: string; negotiation_id?: string; countered?: boolean };
  if (!res.ok) return { ok: false, error: t(OFFER_REASON[res.reason ?? ''] ?? 'actions.couldNotSendThatOffer') };

  revalidate(input.listingId);
  return { ok: true, data: { negotiationId: res.negotiation_id ?? '', countered: !!res.countered } };
}

/** Either party responds on an open thread: counter / accept / decline / withdraw. */
export async function respondToOfferAction(
  input: { negotiationId: string; action: 'counter' | 'accept' | 'decline' | 'withdraw'; amountCents?: number; message?: string; listingId?: string },
): Promise<Result<{ status: string; orderId?: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  if (!input.negotiationId) return { ok: false, error: t('actions.invalidNegotiation') };

  // Accepting creates a confirmed order with the other household, and a
  // counter is an offer the other household's adult can accept into one. The
  // two sides are always different families (0187's distinct_families check),
  // so there is no same-family case to let through: a child or teen is refused
  // both without a read. Decline and withdraw only end the thread.
  if ((input.action === 'accept' || input.action === 'counter') && !isManager(ctx.active.role)) {
    return { ok: false, error: t('actions.onlyAParentGuardianCan16') };
  }

  const amount = input.action === 'counter' ? Math.round(input.amountCents ?? 0) : null;
  if (input.action === 'counter' && (!amount || amount <= 0)) {
    return { ok: false, error: t('actions.enterAValidCounterAmount') };
  }
  const message = input.message?.trim() || null;
  if (message && message.length > 500) return { ok: false, error: t('actions.keepTheNoteUnder500') };

  // Accepting makes the order and a counter offers one; neither is made with a
  // household that closed (see the header). The thread is read with the
  // caller's own session, scoped to their side of it, so the standings asked
  // about are of families the caller is already dealing with; a thread it does
  // not return is left to the RPC's not_found. Their side is EVERY household
  // they belong to, not only the active one: the RPC finds the caller through
  // marketplace_member_id (0154), which answers for any of their families, so
  // a thread of their other household reached it with no standing asked.
  if (input.action === 'accept' || input.action === 'counter') {
    const ownFamilies = [...new Set([ctx.active.familyId, ...ctx.memberships.map((m) => m.familyId)])];
    const { data: thread, error: threadError } = await supabase
      .from('marketplace_negotiations')
      .select('id, listing_id, buyer_family_id')
      .eq('id', input.negotiationId)
      .or(ownFamilies.map(eitherPartyFamily).join(','))
      .maybeSingle();
    if (threadError) return actionFailure('read the negotiation', t('negotiations.couldNotRespondToTheOffer'), threadError);
    if (thread?.listing_id) {
      const service = createServiceClient();
      const seller = await readSellerStanding(service, thread.listing_id);
      const buyer = thread.buyer_family_id ? await readFamilyStanding(service, thread.buyer_family_id) : 'open';
      if (seller === 'unknown' || buyer === 'unknown') return { ok: false, error: t('negotiations.couldNotRespondToTheOffer') };
      if (seller === 'closed' || buyer === 'closed') return { ok: false, error: t('actions.thisFamilyHasClosedItsAccount') };
    }
  }

  const { data, error } = await supabase.rpc('marketplace_negotiation_respond', {
    p_negotiation: input.negotiationId,
    p_action: input.action,
    p_amount: amount,
    p_message: message,
  });
  if (error) return actionFailure('respond to the offer', t('negotiations.couldNotRespondToTheOffer'), error, t);

  const res = (data ?? {}) as { ok?: boolean; reason?: string; status?: string; order_id?: string };
  if (!res.ok) return { ok: false, error: t(RESPOND_REASON[res.reason ?? ''] ?? 'actions.couldNotCompleteThatAction') };

  revalidate(input.listingId);
  if (res.status === 'agreed') revalidatePath('/marketplace/orders');
  return { ok: true, data: { status: res.status ?? 'open', orderId: res.order_id } };
}
