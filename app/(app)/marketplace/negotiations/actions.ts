'use server';

// "Make an Offer" negotiation server actions. Buyers open/counter via
// marketplace_negotiation_offer; either party counters/accepts/declines/
// withdraws via marketplace_negotiation_respond. Both RPCs are SECURITY DEFINER
// and row-lock the listing, verifying the caller is the buyer (in their family)
// or the listing owner (in theirs) — so a race can't hand the same item to two
// buyers. Reads stay under RLS.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';

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

function actionFailure(operation: string, message: string, error: unknown): Result {
  console.error(`[marketplace-negotiations] ${operation} failed`, error);
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
  const supabase = await createServer();
  const amount = Math.round(input.amountCents);
  if (!input.listingId || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: t('actions.enterAValidOfferAmount') };
  }
  const message = input.message?.trim() || null;
  if (message && message.length > 500) return { ok: false, error: t('actions.keepTheNoteUnder500') };

  const { data, error } = await supabase.rpc('marketplace_negotiation_offer', {
    p_listing: input.listingId,
    p_buyer_member: ctx.active.member.id,
    p_buyer_family: ctx.active.familyId,
    p_amount: amount,
    p_message: message,
  });
  if (error) return actionFailure('send the offer', t('marketplace.couldNotSendTheOffer'), error);

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
  void ctx; // auth enforced by requireUserContext + the RPC's ownership checks
  const supabase = await createServer();
  if (!input.negotiationId) return { ok: false, error: t('actions.invalidNegotiation') };

  const amount = input.action === 'counter' ? Math.round(input.amountCents ?? 0) : null;
  if (input.action === 'counter' && (!amount || amount <= 0)) {
    return { ok: false, error: t('actions.enterAValidCounterAmount') };
  }
  const message = input.message?.trim() || null;
  if (message && message.length > 500) return { ok: false, error: t('actions.keepTheNoteUnder500') };

  const { data, error } = await supabase.rpc('marketplace_negotiation_respond', {
    p_negotiation: input.negotiationId,
    p_action: input.action,
    p_amount: amount,
    p_message: message,
  });
  if (error) return actionFailure('respond to the offer', t('negotiations.couldNotRespondToTheOffer'), error);

  const res = (data ?? {}) as { ok?: boolean; reason?: string; status?: string; order_id?: string };
  if (!res.ok) return { ok: false, error: t(RESPOND_REASON[res.reason ?? ''] ?? 'actions.couldNotCompleteThatAction') };

  revalidate(input.listingId);
  if (res.status === 'agreed') revalidatePath('/marketplace/orders');
  return { ok: true, data: { status: res.status ?? 'open', orderId: res.order_id } };
}
