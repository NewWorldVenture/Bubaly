import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { notify } from '@/lib/services/notifications';
import { systemScopeForFamily } from '@/lib/services/scope';
import type { ServiceScope } from '@/lib/services/types';

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
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('closeAuctions.unauthorized') }, { status: 401 });
  }

  const admin = createServiceClient();

  // One scope per family, built once. Each household's quiet hours are its own,
  // and `systemScopeForFamily` reads the real timezone rather than defaulting —
  // a window evaluated in the wrong zone holds a notice at six in the evening
  // and lets one through at two in the morning.
  const scopes = new Map<string, ServiceScope | null>();
  const notifyFamily = async (
    familyId: string,
    n: { title: string; body: string; relatedType: string; relatedId: string | null },
  ): Promise<boolean> => {
    if (!scopes.has(familyId)) scopes.set(familyId, await systemScopeForFamily(admin, familyId));
    const scope = scopes.get(familyId);
    if (!scope) return false;
    const sent = await notify(scope, { recipients: 'family', type: 'system', ...n });
    return sent.ok;
  };
  const nowIso = new Date().toISOString();

  const { data: due, error } = await admin
    .from('marketplace_listings')
    .select('id')
    .eq('sale_format', 'auction').eq('status', 'available')
    .lt('auction_ends_at', nowIso)
    .limit(BATCH);
  if (error) return NextResponse.json({ ok: false, error: t('closeAuctions.couldNotLoadAuctions') }, { status: 500 });

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
      // Two families, so two scopes: quiet hours belong to the household being
      // notified, and this cron runs at 10:00 UTC — late evening for a family in
      // New Zealand and the small hours for some. Not urgent: an auction that
      // closed is still closed in the morning.
      const notified = await Promise.all([
        notifyFamily(result.winner_family_id, {
          title: `You won "${result.title}"`,
          body: `Final price ${price}. Open your orders to arrange pickup.`,
          relatedType: 'marketplace_orders', relatedId: result.order_id ?? null,
        }),
        ...(result.seller_family_id ? [notifyFamily(result.seller_family_id, {
          title: `Auction sold: "${result.title}"`,
          body: `Sold for ${price}. Confirm pickup in your orders.`,
          relatedType: 'marketplace_orders', relatedId: result.order_id ?? null,
        })] : []),
      ]);
      if (notified.some((sent) => !sent)) {
        failed++;
        console.error('Auction winner notification failed');
      }
      sold++;
      continue;
    }

    if (result.had_bids && result.title && result.seller_family_id) {
      const sent = await notifyFamily(result.seller_family_id, {
        title: `Auction ended: "${result.title}"`,
        body: 'The reserve was not met, so it did not sell. Relist it or lower the reserve.',
        relatedType: 'marketplace_listings', relatedId: listing.id,
      });
      if (!sent) {
        failed++;
        console.error('Auction seller notification failed');
      }
    }
    unsold++;
  }

  const ok = failed === 0;
  return NextResponse.json({ ok, closed: sold + unsold, sold, unsold, failed }, { status: ok ? 200 : 502 });
}
