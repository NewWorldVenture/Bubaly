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
 * How far back a settled auction's notices are re-checked. Settlement commits
 * before anyone is told, and once a listing is no longer `available` the due
 * query above never selects it again — so a notice that failed (no scope, a
 * failed write, a thrown read) used to be lost for good, and the winner's
 * notice is their main signal that they owe payment. Every notice is sent
 * `once` per order (or per listing, for an unsold one), so a later run can
 * re-offer it and a delivered one is never repeated. This is the stamp,
 * without a column for it: the notification row itself is the record.
 */
const RETRY_WINDOW_MS = 7 * 24 * 3_600_000;

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
  // A throw here (a scope read or a notify that rejected) used to escape GET,
  // 500 the run part-way, and leave every auction settled earlier in it
  // without its notices. It is a failed notice now, counted like the others.
  const notifyFamily = async (
    familyId: string,
    n: { title: string; body: string; relatedType: string; relatedId: string | null },
  ): Promise<boolean> => {
    try {
      if (!scopes.has(familyId)) scopes.set(familyId, await systemScopeForFamily(admin, familyId));
      const scope = scopes.get(familyId);
      if (!scope) return false;
      const sent = await notify(scope, { recipients: 'family', type: 'system', once: true, ...n });
      return sent.ok;
    } catch (notifyError) {
      console.error('Auction notification threw', notifyError);
      return false;
    }
  };

  // The two notices of a sold auction, and the one of an unsold auction that
  // had bids. One definition, used at settlement and on every retry.
  const noticeSold = async (n: {
    title: string; winnerFamilyId: string; sellerFamilyId: string | null; amountCents: number; orderId: string | null;
  }): Promise<boolean[]> => {
    const price = NOTICE_READER.money(n.amountCents);
    // Two families, so two scopes: quiet hours belong to the household being
    // notified, and this cron runs at 10:00 UTC — late evening for a family in
    // New Zealand and the small hours for some. Not urgent: an auction that
    // closed is still closed in the morning.
    const notified = await Promise.all([
      notifyFamily(n.winnerFamilyId, {
        title: NOTICE_READER.t('closeAuctions.youWonTitle', { title: n.title }),
        body: NOTICE_READER.t('closeAuctions.finalPriceBody', { amount: price }),
        relatedType: 'marketplace_orders', relatedId: n.orderId,
      }),
      ...(n.sellerFamilyId ? [notifyFamily(n.sellerFamilyId, {
        title: NOTICE_READER.t('closeAuctions.auctionSoldTitle', { title: n.title }),
        body: NOTICE_READER.t('closeAuctions.soldForBody', { amount: price }),
        relatedType: 'marketplace_orders', relatedId: n.orderId,
      })] : []),
    ]);
    return notified;
  };
  const noticeUnsold = (n: { title: string; sellerFamilyId: string; listingId: string }) =>
    notifyFamily(n.sellerFamilyId, {
      title: NOTICE_READER.t('closeAuctions.auctionEndedTitle', { title: n.title }),
      body: NOTICE_READER.t('closeAuctions.reserveNotMetBody'),
      relatedType: 'marketplace_listings', relatedId: n.listingId,
    });
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
  const settledThisRun = new Set<string>();
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
    settledThisRun.add(listing.id);

    if (result.sold && result.winner_family_id && result.title) {
      const notified = await noticeSold({
        title: result.title, winnerFamilyId: result.winner_family_id, sellerFamilyId: result.seller_family_id ?? null,
        amountCents: Number(result.current_bid_cents ?? 0), orderId: result.order_id ?? null,
      });
      if (notified.some((sent) => !sent)) {
        failed++;
        console.error('Auction winner notification failed; a later run re-offers it');
      }
      sold++;
      continue;
    }

    if (result.had_bids && result.title && result.seller_family_id) {
      const sent = await noticeUnsold({ title: result.title, sellerFamilyId: result.seller_family_id, listingId: listing.id });
      if (!sent) {
        failed++;
        console.error('Auction seller notification failed; a later run re-offers it');
      }
    }
    unsold++;
  }

  // Re-offer the notices of auctions settled by an EARLIER run. Each is sent
  // `once`, so one already delivered is a no-op and only a lost one goes out.
  let rechecked = 0;
  const { data: recent, error: recentError } = await admin
    .from('marketplace_listings')
    .select('id, title, family_id, status, bid_count, claimed_by, highest_bidder_member_id, highest_bidder_family_id')
    .eq('sale_format', 'auction').in('status', ['claimed', 'withdrawn'])
    .gte('auction_closed_at', new Date(Date.now() - RETRY_WINDOW_MS).toISOString())
    .order('auction_closed_at', { ascending: false })
    .limit(BATCH);
  if (recentError) {
    failed++;
    console.error('Could not load settled auctions to re-check their notices', recentError);
  }
  for (const listing of recent ?? []) {
    if (settledThisRun.has(listing.id) || !listing.title || !listing.family_id) continue;
    if (listing.status === 'claimed') {
      // Won at auction: claimed by the highest bidder. A Buy-It-Now is claimed
      // by its buyer and has no "Won at auction" order, so it is not mistaken
      // for one.
      if (!listing.highest_bidder_family_id || !listing.claimed_by
        || listing.claimed_by !== listing.highest_bidder_member_id) continue;
      const { data: order, error: orderError } = await admin.from('marketplace_orders')
        .select('id, amount_cents').eq('listing_id', listing.id).eq('notes', 'Won at auction').maybeSingle();
      if (orderError) { failed++; console.error('Could not load a won auction order', orderError); continue; }
      if (!order) continue;
      const sent = (await noticeSold({
        title: listing.title, winnerFamilyId: listing.highest_bidder_family_id, sellerFamilyId: listing.family_id,
        amountCents: Number(order.amount_cents ?? 0), orderId: order.id,
      })).every(Boolean);
      if (!sent) { failed++; console.error('Auction winner notification retry failed'); } else rechecked++;
    } else if (listing.status === 'withdrawn' && Number(listing.bid_count ?? 0) > 0) {
      const sent = await noticeUnsold({ title: listing.title, sellerFamilyId: listing.family_id, listingId: listing.id });
      if (!sent) { failed++; console.error('Auction seller notification retry failed'); } else rechecked++;
    }
  }

  const ok = failed === 0;
  return NextResponse.json({ ok, closed: sold + unsold, sold, unsold, failed, rechecked }, { status: ok ? 200 : 502 });
}
