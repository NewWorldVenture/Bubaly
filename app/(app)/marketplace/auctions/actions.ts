'use server';

// Auction server actions: place a proxy bid (via the atomic
// marketplace_place_bid RPC) and Buy-It-Now. Both are family-scoped through
// requireUserContext; the RPC row-locks the listing so concurrent bids can
// never both win. Reads stay under RLS.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { MARKETPLACE_CURRENCY } from '@/lib/marketplace/listings';
import { getFormat } from '@/lib/utils/format-server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { buyNowClosedByBids } from '@/lib/marketplace/auction';
import { readBidTarget } from '@/lib/marketplace/circle-reads';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const BID_REASON: Record<string, string> = {
  unauthorized: 'actions.youCanTPlaceA',
  invalid_amount: 'actions.enterAValidBidAmount',
  not_found: 'actions.thatListingNoLongerExists',
  not_auction: 'actions.thisListingIsnTAn',
  not_available: 'actions.biddingHasClosedOnThis',
  ended: 'actions.thisAuctionHasEnded',
  not_started: 'actions.thisAuctionHasnTStarted',
  own_listing: 'actions.youCanTBidOn',
  too_low: 'actions.yourBidIsBelowThe',
  // From the proposed economy SQL (sections 5 and 7): the RPC's own role gate,
  // and the leading household resubmitting a max that is not above its own.
  manager_only: 'actions.onlyAParentGuardianCan16',
  already_leading: 'actions.yourMaxAlreadyCoversThat',
};

/**
 * Place a proxy (max) bid. The bidder submits the most they'd pay; the RPC
 * reveals only enough to lead, marks the prior leader outbid, and extends the
 * clock on a last-minute bid (anti-snipe).
 */
export async function placeBidAction(input: { listingId: string; maxCents: number }): Promise<Result<{ leading: boolean; currentCents: number; extended?: boolean }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const maxCents = Math.round(input.maxCents);
  if (!input.listingId || !Number.isFinite(maxCents) || maxCents <= 0 || maxCents > 1_000_000_000_00) {
    return { ok: false, error: t('actions.enterAValidBidAmount') };
  }
  // Every auction a family can bid on belongs to ANOTHER household (the RPC
  // refuses own_listing), so a bid is a commitment to pay another family's
  // adult and, on winning, to meet them. A child or teen does not make it.
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentGuardianCan16') };

  // A household that already leads is not raised against itself. The proxy
  // engine treats any higher max as a NEW leader and moves the visible price
  // to the old max plus an increment, so the leader re-bidding (or another
  // member of the same family) pushed up the price they would pay with no
  // competitor at all. Refused here until the proposed economy SQL lands: its
  // section 5 teaches marketplace_place_bid the "same leader" branch (only the
  // hidden max rises, or `already_leading`), and then the RPC handles it and
  // this refusal can go. The listing is another family's, so the read goes
  // through the circle view when the database has it (readBidTarget).
  const { data: listing, error: listingError } = await readBidTarget(supabase, input.listingId);
  if (listingError) return { ok: false, error: t('actions.couldNotPlaceThatBid') };
  if (listing && listing.highest_bidder_family_id === ctx.active.familyId) {
    return { ok: false, error: t('actions.youAlreadyLeadThisAuction') };
  }

  const { data, error } = await supabase.rpc('marketplace_place_bid', {
    p_listing_id: input.listingId,
    p_bidder_member_id: ctx.active.member.id,
    p_bidder_family_id: ctx.active.familyId,
    p_max_cents: maxCents,
  });
  if (error) return { ok: false, error: t('actions.couldNotPlaceThatBid') };

  const res = (data ?? {}) as { ok?: boolean; reason?: string; min_cents?: number; leading?: boolean; current_cents?: number; extended?: boolean };
  if (!res.ok) {
    // BID_REASON holds KEYS, because it is built once at module load and the
    // locale belongs to the request. Translating happens here, where it is known.
    if (res.reason === 'too_low' && res.min_cents) {
      // The bidder reads this in a toast, so the minimum is in THEIR notation: it
      // was `$${(min / 100).toFixed(2)}`, a literal symbol with no locale at all.
      // getFormat() reads the same request locale getTranslations() just did.
      const { fmtMoney } = await getFormat();
      return { ok: false, error: t('actions.minimumBidIs', { amount: fmtMoney(res.min_cents, MARKETPLACE_CURRENCY) }) };
    }
    return { ok: false, error: t(BID_REASON[res.reason ?? ''] ?? 'actions.couldNotPlaceThatBid') };
  }

  revalidatePath(`/marketplace/item/${input.listingId}`);
  revalidatePath('/marketplace/auctions');
  return { ok: true, data: { leading: !!res.leading, currentCents: res.current_cents ?? 0, extended: res.extended } };
}

/**
 * Buy-It-Now: instantly end the auction at the fixed price. Atomically flips the
 * listing to claimed (only if still available) and creates the order, so two
 * buyers can't both win. Records the winning member as buyer.
 */
export async function buyNowAction(listingId: string): Promise<Result<{ orderId: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  if (!listingId) return { ok: false, error: t('actions.invalidListing') };
  // Buying commits the household to pay and meet another family's adult.
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentGuardianCan16') };
  // Buy-It-Now closes once bidding has begun (the panel hides it then too): a
  // standing bid can already be above the fixed price, and Buy-It-Now would
  // let anyone undercut the leader and hand the seller less than was bid.
  const { data: listing, error: listingError } = await readBidTarget(supabase, listingId);
  if (listingError) return { ok: false, error: t('actions.couldNotCompleteBuyIt') };
  if (!listing) return { ok: false, error: t('actions.listingNotFound') };
  if (buyNowClosedByBids(listing.bid_count)) return { ok: false, error: t('actions.buyItNowIsnT') };
  const { data, error } = await supabase.rpc('marketplace_buy_now', {
    p_listing_id: listingId,
    p_buyer_member_id: ctx.active.member.id,
    p_buyer_family_id: ctx.active.familyId,
  });
  if (error) return { ok: false, error: t('actions.couldNotCompleteBuyIt') };
  const result = (data ?? {}) as { ok?: boolean; reason?: string; detail?: string; order_id?: string };
  if (!result.ok || !result.order_id) {
    const reason = result.reason;
    // The proposed economy SQL (sections 6 and 7) adds two refusals: its own
    // role gate, and `not_available` with detail `bids_placed` when a bid
    // landed between the pre-read above and the listing lock. That second one
    // is the pre-read's own rule (buyNowClosedByBids), so it says the same.
    if (reason === 'manager_only') return { ok: false, error: t('actions.onlyAParentGuardianCan16') };
    if (reason === 'not_available' && result.detail === 'bids_placed') return { ok: false, error: t('actions.buyItNowIsnT') };
    if (reason === 'own_listing') return { ok: false, error: t('actions.youCanTBuyYour') };
    if (reason === 'ended') return { ok: false, error: t('actions.thisAuctionHasEnded') };
    if (reason === 'not_started') return { ok: false, error: t('actions.thisAuctionHasnTStarted') };
    if (reason === 'not_found') return { ok: false, error: t('actions.listingNotFound') };
    return { ok: false, error: t('actions.buyItNowIsnT') };
  }

  revalidatePath(`/marketplace/item/${listingId}`);
  revalidatePath('/marketplace/orders');
  return { ok: true, data: { orderId: result.order_id } };
}
