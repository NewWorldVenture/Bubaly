import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Finds expired auctions and delegates each settlement to the service-role
// RPC. Listing, order, and bid state changes commit together; notifications
// remain best-effort after the transaction succeeds.
const BATCH = 50;

type CloseResult = {
  ok?: boolean;
  reason?: string;
  sold?: boolean;
  had_bids?: boolean;
  title?: string;
  seller_family_id?: string;
  winner_family_id?: string;
  current_bid_cents?: number;
  order_id?: string | null;
};

export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createServiceClient();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await admin
    .from('marketplace_listings')
    .select('id')
    .eq('sale_format', 'auction').eq('status', 'available')
    .lt('auction_ends_at', nowIso)
    .limit(BATCH);
  if (error) return NextResponse.json({ ok: false, error: 'Could not load auctions.' }, { status: 500 });

  let sold = 0;
  let unsold = 0;
  let failed = 0;
  for (const listing of due ?? []) {
    const { data: closed, error: closeError } = await admin.rpc('marketplace_close_auction', {
      p_listing_id: listing.id,
      p_now: nowIso,
    });
    if (closeError) {
      // The RPC transaction rolls back on settlement failure, leaving this
      // listing available for a later retry instead of losing the order.
      console.error('Auction settlement failed; leaving it retryable.', closeError);
      failed++;
      continue;
    }

    const result = (closed ?? {}) as CloseResult;
    if (!result.ok || result.reason !== 'closed') continue;

    if (result.sold && result.winner_family_id && result.title) {
      const price = `$${(Number(result.current_bid_cents ?? 0) / 100).toFixed(2)}`;
      await admin.from('notifications').insert([
        { family_id: result.winner_family_id, user_id: null, type: 'system' as const,
          title: `You won "${result.title}"`, body: `Final price ${price}. Open your orders to arrange pickup.`,
          related_type: 'marketplace_orders', related_id: result.order_id ?? null },
        ...(result.seller_family_id ? [{ family_id: result.seller_family_id, user_id: null, type: 'system' as const,
          title: `Auction sold: "${result.title}"`, body: `Sold for ${price}. Confirm pickup in your orders.`,
          related_type: 'marketplace_orders', related_id: result.order_id ?? null }] : []),
      ]).select('id');
      sold++;
      continue;
    }

    if (result.had_bids && result.title && result.seller_family_id) {
      await admin.from('notifications').insert({
        family_id: result.seller_family_id, user_id: null, type: 'system' as const,
        title: `Auction ended: "${result.title}"`,
        body: 'The reserve was not met, so it did not sell. Relist it or lower the reserve.',
        related_type: 'marketplace_listings', related_id: listing.id,
      });
    }
    unsold++;
  }

  const ok = failed === 0;
  return NextResponse.json({ ok, closed: sold + unsold, sold, unsold, failed }, { status: ok ? 200 : 502 });
}
