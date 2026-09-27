import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { MARKETPLACE_CURRENCY } from '@/lib/marketplace/listings';
import { createFormat } from '@/lib/utils/format';
import { notify } from '@/lib/services/notifications';
import { systemScopeForFamily } from '@/lib/services/scope';
import type { ServiceScope } from '@/lib/services/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Finds expired auctions and delegates each settlement to the service-role
// RPC. Listing, order, and bid state changes commit together; notifications
// remain best-effort after the transaction succeeds.
const BATCH = 50;

/**
 * Who the auction notices are written for — and the honest answer is "nobody in
 * particular", which is why it is spelled out rather than defaulted.
 *
 * These notices go to two households that are not in this request (the cron's
 * own headers, and so `getTranslations()` above, belong to the SCHEDULER), and a
 * family's language choice is stored nowhere but a browser cookie
 * (LOCALE_COOKIE): no column on families, family_members or profiles carries it
 * (I18N-001). So a German household still reads these in English with a US
 * amount; this change does not fix that, and nothing short of a stored
 * recipient locale can.
 *
 * What it does make true: the amount comes from Intl, not a hand-written "$", and
 * EVERY word of the title and body is a catalogue sentence read through this one
 * reader — the source locale and the source catalogue, the same choice
 * lib/briefing/deliver.ts makes for the morning brief. So when a recipient
 * locale is persisted, this reader is the one thing that becomes a per-family
 * read; there is no English left in the route to translate by hand.
 */
const NOTICE_LOCALE: LocaleCode = 'en-US';
const NOTICE_READER = {
  money: (cents: number) => createFormat(NOTICE_LOCALE).fmtMoney(cents, MARKETPLACE_CURRENCY),
  t: (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
};

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
      const price = NOTICE_READER.money(Number(result.current_bid_cents ?? 0));
      // Two families, so two scopes: quiet hours belong to the household being
      // notified, and this cron runs at 10:00 UTC — late evening for a family in
      // New Zealand and the small hours for some. Not urgent: an auction that
      // closed is still closed in the morning.
      const notified = await Promise.all([
        notifyFamily(result.winner_family_id, {
          title: NOTICE_READER.t('closeAuctions.youWonTitle', { title: result.title }),
          body: NOTICE_READER.t('closeAuctions.finalPriceBody', { amount: price }),
          relatedType: 'marketplace_orders', relatedId: result.order_id ?? null,
        }),
        ...(result.seller_family_id ? [notifyFamily(result.seller_family_id, {
          title: NOTICE_READER.t('closeAuctions.auctionSoldTitle', { title: result.title }),
          body: NOTICE_READER.t('closeAuctions.soldForBody', { amount: price }),
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
        title: NOTICE_READER.t('closeAuctions.auctionEndedTitle', { title: result.title }),
        body: NOTICE_READER.t('closeAuctions.reserveNotMetBody'),
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
