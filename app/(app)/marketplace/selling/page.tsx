import type { Metadata } from 'next';
import Link from 'next/link';
import { LayoutDashboard, ArrowRight, Plus } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { ListingImage } from '@/components/marketplace/listing-image';
import { ErrorState } from '@/components/ui/states';
import { auctionStatus } from '@/lib/marketplace/auction';
import {
  attentionItems, rankListings, sellerTotals, needsAttention,
  type ListingSignals, type AttentionTone,
} from '@/lib/marketplace/selling';
import { cn } from '@/lib/utils/cn';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Selling · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

const CHIP_TONE: Record<AttentionTone, string> = {
  danger: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  info: 'bg-sky-500/12 text-sky-600 dark:text-sky-400',
  muted: 'bg-border/60 text-muted',
};

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="module-page space-y-4">
      <PageHeader title={t('selling.selling')} description={t('selling.yourSellerCockpitIsTemporarily')} />
      <ErrorState message={t('selling.couldNotLoadSellerActivity')} />
      <Link href="/marketplace/selling" className="text-sm font-medium text-brand-text underline">{t('selling.refreshSelling')}</Link>
    </div>
  );
}

/** Seller cockpit — every listing you're selling, ranked by what needs your
 *  attention: questions to answer, offers to reply to, pickups to confirm,
 *  overdue returns, plus interest (watchers, bids, offers). */
export default async function SellingPage() {
  const t = await getTranslations();
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const selfId = ctx.active.member.id;
  const now = new Date();

  const { data: listings, error: listingsError } = await sb
    .from('marketplace_listings')
    .select('id, title, photo_url, kind, status, price_cents, sale_format, bid_count, auction_starts_at, auction_ends_at')
    .eq('family_id', familyId).eq('member_id', selfId)
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = listings ?? [];
  const ids = rows.map((l) => l.id);

  // Batch every signal, keyed by listing_id, then tally in memory.
  const tally = (arr: { listing_id: string | null }[] | null | undefined) => {
    const m = new Map<string, number>();
    for (const r of arr ?? []) if (r.listing_id) m.set(r.listing_id, (m.get(r.listing_id) ?? 0) + 1);
    return m;
  };

  const signalResults = ids.length
    ? await settleAll([
        sb.from('marketplace_saves').select('listing_id').in('listing_id', ids),
        sb.from('marketplace_offers').select('listing_id').eq('status', 'open').in('listing_id', ids),
        sb.from('marketplace_negotiations').select('listing_id, last_actor').eq('status', 'open').in('listing_id', ids),
        sb.from('marketplace_questions').select('listing_id').is('answer', null).in('listing_id', ids),
        sb.from('marketplace_handoffs').select('listing_id').eq('status', 'proposed').eq('proposer_role', 'buyer').in('listing_id', ids),
        sb.from('marketplace_orders').select('listing_id, ends_on, returned_at, status, kind')
          .eq('seller_member', selfId).in('kind', ['rent', 'borrow']).in('status', ['confirmed', 'active']).in('listing_id', ids),
      ])
    : [];
  const signalError = signalResults.find((result) => result.error)?.error;
  if (listingsError || signalError) {
    console.error('[marketplace-selling] seller read failed', listingsError ?? signalError);
    return <ReadFailure />;
  }
  const [savesRes, offersRes, negRes, qRes, handoffRes, overdueRes] = signalResults.length
    ? signalResults
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const watchers = tally(savesRes.data);
  const offers = tally(offersRes.data);
  const negAll = tally((negRes.data ?? []).map((r) => ({ listing_id: r.listing_id })));
  const negMine = tally((negRes.data ?? []).filter((r) => r.last_actor === 'buyer').map((r) => ({ listing_id: r.listing_id })));
  const questions = tally(qRes.data);
  const handoffs = tally(handoffRes.data);
  const today = now.toISOString().slice(0, 10);
  const overdue = tally((overdueRes.data ?? [])
    .filter((o) => !o.returned_at && o.ends_on && o.ends_on < today)
    .map((o) => ({ listing_id: o.listing_id })));

  const signals: (ListingSignals & { photo: string | null; price: number })[] = rows.map((l) => {
    const isAuction = l.sale_format === 'auction';
    const endingSoon = isAuction && auctionStatus({
      saleFormat: l.sale_format, status: l.status, startingBidCents: 0, currentBidCents: 0, bidCount: l.bid_count ?? 0,
      reserveCents: null, buyNowCents: null, auctionStartsAt: l.auction_starts_at, auctionEndsAt: l.auction_ends_at,
    }, now) === 'ending_soon';
    return {
      id: l.id, title: l.title, status: l.status, saleFormat: l.sale_format ?? 'fixed',
      watchers: watchers.get(l.id) ?? 0,
      openOffers: offers.get(l.id) ?? 0,
      openNegotiations: negAll.get(l.id) ?? 0,
      myTurnNegotiations: negMine.get(l.id) ?? 0,
      unansweredQuestions: questions.get(l.id) ?? 0,
      auctionBids: isAuction ? (l.bid_count ?? 0) : 0,
      auctionEndingSoon: endingSoon,
      pendingHandoffs: handoffs.get(l.id) ?? 0,
      overdueReturns: overdue.get(l.id) ?? 0,
      photo: l.photo_url, price: l.price_cents,
    };
  });

  const ranked = rankListings(signals) as typeof signals;
  const totals = sellerTotals(signals);

  const tiles = [
    { label: 'Active listings', value: totals.activeListings, icon: '🏷️' },
    { label: 'Needs attention', value: totals.needsAttention, icon: '🔔' },
    { label: 'Watchers', value: totals.watchers, icon: '👀' },
    { label: 'Open offers', value: totals.openOffers, icon: '🤝' },
    { label: 'Questions', value: totals.questionsToAnswer, icon: '💬' },
  ];

  return (
    <div className="module-page">
      <PageHeader
        title={tr('marketplaceSelling.selling')}
        description={t('selling.everythingYouReSellingRanked')}
        action={
          <Link href="/marketplace/browse?post=1" className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg transition hover:opacity-90">
            <Plus className="h-4 w-4" /> {tr('marketplaceSelling.postAnItem')}
          </Link>
        }
      />

      <div className="grid-stats mb-5">
        {tiles.map((t) => (
          <div key={t.label} className="stat-card">
            <span className="text-2xl">{t.icon}</span>
            <div><div className="text-2xl font-bold">{t.value}</div><div className="text-[11px] text-muted">{t.label}</div></div>
          </div>
        ))}
      </div>

      {ranked.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-10 text-center">
          <LayoutDashboard className="mx-auto h-8 w-8 text-muted/40" />
          <p className="mt-3 text-sm font-semibold">{tr('marketplaceSelling.youreNotSellingAnythingYet')}</p>
          <p className="mt-1 text-sm text-muted">{tr('marketplaceSelling.postYourFirstItemAndThis')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {ranked.map((s) => {
            const items = attentionItems(s);
            return (
              <li key={s.id}>
                <Link href={`/marketplace/item/${s.id}`}
                  className={cn('flex items-center gap-3 rounded-xl border bg-surface/60 p-3 transition hover:border-brand/40',
                    needsAttention(s) ? 'border-amber-500/30' : 'border-border')}>
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                    <ListingImage src={s.photo} alt={s.title} className="h-full w-full object-cover"
                      fallback={<div className="flex h-full w-full items-center justify-center bg-elevated text-muted">🏷️</div>} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold">{s.title}</p>
                      <span className="shrink-0 text-xs capitalize text-muted">· {s.status}</span>
                    </div>
                    {items.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {items.map((it, i) => (
                          <span key={i} className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', CHIP_TONE[it.tone])}>{it.label}</span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-muted">{t('selling.noActivityYet')}</p>
                    )}
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
