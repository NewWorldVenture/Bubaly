import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { reserveMet } from '@/lib/marketplace/auction';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Closes expired marketplace auctions: determines the winner (highest bidder,
// if the reserve is met), creates a confirmed order, marks the winning bid
// 'won' + the rest 'lost', flips the listing to claimed/withdrawn, and notifies
// both the winner and the seller. Idempotent: only auctions still 'available'
// with a past end time are processed, and each flips out of that set atomically.
const BATCH = 50;

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createServiceClient();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await admin
    .from('marketplace_listings')
    .select('id, family_id, member_id, title, current_bid_cents, bid_count, reserve_cents, highest_bidder_member_id, highest_bidder_family_id, sale_format, status, auction_ends_at')
    .eq('sale_format', 'auction').eq('status', 'available')
    .lt('auction_ends_at', nowIso)
    .limit(BATCH);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  let sold = 0, unsold = 0;
  for (const l of due ?? []) {
    const soldNow = reserveMet({ reserveCents: l.reserve_cents, currentBidCents: l.current_bid_cents, bidCount: l.bid_count })
      && l.bid_count > 0 && !!l.highest_bidder_member_id && !!l.highest_bidder_family_id;

    // Atomic close: only if still available (guards a concurrent Buy-It-Now).
    const { data: closed } = await admin
      .from('marketplace_listings')
      .update({ status: soldNow ? 'claimed' : 'withdrawn', auction_closed_at: nowIso,
                claimed_by: soldNow ? l.highest_bidder_member_id : null,
                claimed_at: soldNow ? nowIso : null })
      .eq('id', l.id).eq('status', 'available')
      .select('id').maybeSingle();
    if (!closed) continue;   // someone else closed it (buy-now) — skip

    if (soldNow) {
      // soldNow guarantees both are set (see the guard above); narrow for TS.
      const winnerMember = l.highest_bidder_member_id as string;
      const winnerFamily = l.highest_bidder_family_id as string;
      const { data: order } = await admin.from('marketplace_orders').insert({
        family_id: l.family_id, listing_id: l.id,
        buyer_member: winnerMember, seller_member: l.member_id,
        kind: 'buy', status: 'confirmed', amount_cents: l.current_bid_cents,
        notes: 'Won at auction',
      }).select('id').single();

      await admin.from('marketplace_bids').update({ status: 'won' })
        .eq('listing_id', l.id).eq('bidder_member_id', winnerMember).eq('status', 'active');
      await admin.from('marketplace_bids').update({ status: 'lost' })
        .eq('listing_id', l.id).in('status', ['active', 'outbid']);

      // Notify winner + seller (best-effort; degrades if notifications missing).
      const price = `$${(l.current_bid_cents / 100).toFixed(2)}`;
      await admin.from('notifications').insert([
        { family_id: winnerFamily, user_id: null, type: 'system',
          title: `🏆 You won "${l.title}"`, body: `Final price ${price}. Open your orders to arrange pickup.`,
          related_type: 'marketplace_orders', related_id: order?.id ?? null },
        { family_id: l.family_id, user_id: null, type: 'system',
          title: `Auction sold: "${l.title}"`, body: `Sold for ${price}. Confirm pickup in your orders.`,
          related_type: 'marketplace_orders', related_id: order?.id ?? null },
      ]).select('id');
      sold++;
    } else {
      await admin.from('marketplace_bids').update({ status: 'lost' }).eq('listing_id', l.id).in('status', ['active', 'outbid']);
      if (l.bid_count > 0) {
        await admin.from('notifications').insert({
          family_id: l.family_id, user_id: null, type: 'system',
          title: `Auction ended: "${l.title}"`,
          body: 'The reserve wasn’t met, so it didn’t sell. Relist it or lower the reserve.',
          related_type: 'marketplace_listings', related_id: l.id,
        });
      }
      unsold++;
    }
  }

  return NextResponse.json({ ok: true, closed: sold + unsold, sold, unsold });
}
