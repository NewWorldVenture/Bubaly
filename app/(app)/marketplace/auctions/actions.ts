'use server';

// Auction server actions: place a proxy bid (via the atomic
// marketplace_place_bid RPC) and Buy-It-Now. Both are family-scoped through
// requireUserContext; the RPC row-locks the listing so concurrent bids can
// never both win. Reads stay under RLS.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const BID_REASON: Record<string, string> = {
  unauthorized: 'You can’t place a bid for this account.',
  invalid_amount: 'Enter a valid bid amount.',
  not_found: 'That listing no longer exists.',
  not_auction: 'This listing isn’t an auction.',
  not_available: 'Bidding has closed on this listing.',
  ended: 'This auction has ended.',
  not_started: 'This auction hasn’t started yet.',
  own_listing: 'You can’t bid on your own family’s listing.',
  too_low: 'Your bid is below the minimum — raise it and try again.',
};

/**
 * Place a proxy (max) bid. The bidder submits the most they'd pay; the RPC
 * reveals only enough to lead, marks the prior leader outbid, and extends the
 * clock on a last-minute bid (anti-snipe).
 */
export async function placeBidAction(input: { listingId: string; maxCents: number }): Promise<Result<{ leading: boolean; currentCents: number; extended?: boolean }>> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const maxCents = Math.round(input.maxCents);
  if (!input.listingId || !Number.isFinite(maxCents) || maxCents <= 0 || maxCents > 1_000_000_000_00) {
    return { ok: false, error: 'Enter a valid bid amount.' };
  }

  const { data, error } = await supabase.rpc('marketplace_place_bid', {
    p_listing_id: input.listingId,
    p_bidder_member_id: ctx.active.member.id,
    p_bidder_family_id: ctx.active.familyId,
    p_max_cents: maxCents,
  });
  if (error) return { ok: false, error: 'Could not place that bid right now.' };

  const res = (data ?? {}) as { ok?: boolean; reason?: string; min_cents?: number; leading?: boolean; current_cents?: number; extended?: boolean };
  if (!res.ok) {
    const msg = BID_REASON[res.reason ?? ''] ?? 'Could not place that bid.';
    return { ok: false, error: res.reason === 'too_low' && res.min_cents ? `Minimum bid is $${(res.min_cents / 100).toFixed(2)}.` : msg };
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
  const ctx = await requireUserContext();
  const supabase = await createServer();
  if (!listingId) return { ok: false, error: 'Invalid listing.' };
  const { data, error } = await supabase.rpc('marketplace_buy_now', {
    p_listing_id: listingId,
    p_buyer_member_id: ctx.active.member.id,
    p_buyer_family_id: ctx.active.familyId,
  });
  if (error) return { ok: false, error: 'Could not complete Buy-It-Now right now.' };
  const result = (data ?? {}) as { ok?: boolean; reason?: string; order_id?: string };
  if (!result.ok || !result.order_id) {
    const reason = result.reason;
    if (reason === 'own_listing') return { ok: false, error: 'You can’t buy your own family’s listing.' };
    if (reason === 'ended') return { ok: false, error: 'This auction has ended.' };
    if (reason === 'not_started') return { ok: false, error: 'This auction hasn’t started yet.' };
    if (reason === 'not_found') return { ok: false, error: 'Listing not found.' };
    return { ok: false, error: 'Buy-It-Now isn’t available on this listing.' };
  }

  revalidatePath(`/marketplace/item/${listingId}`);
  revalidatePath('/marketplace/orders');
  return { ok: true, data: { orderId: result.order_id } };
}
