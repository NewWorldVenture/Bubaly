import type { Metadata } from 'next';
import Link from 'next/link';
import { Gavel, Clock, Flame, TrendingUp } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ListingImage } from '@/components/marketplace/listing-image';
import { ErrorState } from '@/components/ui/states';
import { auctionStatus, timeLeft, reserveMet, type AuctionListing } from '@/lib/marketplace/auction';
import { cn } from '@/lib/utils/cn';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Live Auctions · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="module-page space-y-4">
      <h1 className="flex items-center gap-2 text-2xl font-black sm:text-3xl"><Gavel className="h-6 w-6 text-brand-text" /> Live Auctions</h1>
      <ErrorState message="Could not load live auctions from Supabase. Refresh and try again." />
      <Link href="/marketplace/auctions" className="text-sm font-medium text-brand-text underline">{t('auctions.refreshAuctions')}</Link>
    </div>
  );
}

type Row = {
  id: string; title: string; photo_url: string | null; category: string;
  sale_format: string; status: string; starting_bid_cents: number; current_bid_cents: number;
  bid_count: number; reserve_cents: number | null; buy_now_cents: number | null;
  auction_starts_at: string | null; auction_ends_at: string | null;
};

/** Live auctions board — the eBay-beating surface: ending-soon first, with live
 *  countdowns, bid counts, reserve state, and Buy-It-Now flags. */
export default async function AuctionsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const sb = await createServer();
  const now = new Date();

  // Family + reachable (RLS/circles) auctions that are still open, soonest-ending first.
  const { data, error } = await sb
    .from('marketplace_listings')
    .select('id, title, photo_url, category, sale_format, status, starting_bid_cents, current_bid_cents, bid_count, reserve_cents, buy_now_cents, auction_starts_at, auction_ends_at')
    .eq('sale_format', 'auction').eq('status', 'available')
    .gt('auction_ends_at', now.toISOString())
    .order('auction_ends_at', { ascending: true })
    .limit(60);
  if (error) {
    console.error('[marketplace-auctions] listing read failed', error);
    return <ReadFailure />;
  }

  const rows = (data ?? []) as Row[];
  const toAuction = (r: Row): AuctionListing => ({
    saleFormat: r.sale_format, status: r.status, startingBidCents: r.starting_bid_cents,
    currentBidCents: r.current_bid_cents, bidCount: r.bid_count, reserveCents: r.reserve_cents,
    buyNowCents: r.buy_now_cents, auctionStartsAt: r.auction_starts_at, auctionEndsAt: r.auction_ends_at,
  });

  const endingSoon = rows.filter((r) => auctionStatus(toAuction(r), now) === 'ending_soon').length;
  const withBids = rows.filter((r) => r.bid_count > 0).length;

  return (
    <div className="module-page">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black sm:text-3xl">
            <Gavel className="h-6 w-6 text-brand-text" /> {t('marketplaceAuctions.liveAuctions')}
          </h1>
          <p className="mt-1 text-sm text-muted">{t('marketplaceAuctions.bidOnWhatYourCommunityIs')}</p>
        </div>
        <Link href="/marketplace/browse?post=1" className="inline-flex items-center gap-1.5 self-start rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg transition hover:opacity-90 sm:self-auto">
          <TrendingUp className="h-4 w-4" /> {t('marketplaceAuctions.sellAtAuction')}
        </Link>
      </div>

      {/* Stats */}
      <div className="grid-stats mb-5">
        {[
          { label: 'Live now', value: rows.length, icon: '🔨' },
          { label: 'Ending soon', value: endingSoon, icon: '🔥' },
          { label: 'With bids', value: withBids, icon: '📈' },
        ].map((s) => (
          <div key={s.label} className="stat-card">
            <span className="text-2xl">{s.icon}</span>
            <div><div className="text-2xl font-bold">{s.value}</div><div className="text-[11px] text-muted">{s.label}</div></div>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-10 text-center">
          <Gavel className="mx-auto h-8 w-8 text-muted/40" />
          <p className="mt-3 text-sm font-semibold">{t('marketplaceAuctions.noLiveAuctionsRightNow')}</p>
          <p className="mt-1 text-sm text-muted">{t('marketplaceAuctions.beTheFirstListAnItem')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {rows.map((r) => {
            const a = toAuction(r);
            const soon = auctionStatus(a, now) === 'ending_soon';
            const resMet = reserveMet(a);
            return (
              <Link key={r.id} href={`/marketplace/item/${r.id}`}
                className="group overflow-hidden rounded-2xl border border-border bg-surface/40 transition hover:border-brand/40">
                <div className="relative aspect-square">
                  <ListingImage src={r.photo_url} alt={r.title} className="h-full w-full object-cover"
                    fallback={<div className="flex h-full w-full items-center justify-center bg-elevated"><Gavel className="h-8 w-8 text-muted/40" /></div>} />
                  <div className={cn('absolute left-2 top-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold backdrop-blur',
                    soon ? 'bg-rose-500/80 text-white' : 'bg-black/55 text-white')}>
                    <Clock className="h-2.5 w-2.5" /> {timeLeft(r.auction_ends_at, now)}
                  </div>
                  {soon && <Flame className="absolute right-2 top-2 h-4 w-4 text-rose-400 drop-shadow" />}
                </div>
                <div className="p-3">
                  <p className="truncate text-sm font-semibold">{r.title}</p>
                  <div className="mt-1 flex items-baseline justify-between">
                    <span className="text-base font-bold tabular-nums">{money(r.bid_count > 0 ? r.current_bid_cents : r.starting_bid_cents)}</span>
                    <span className="text-[11px] text-muted">{r.bid_count} bid{r.bid_count === 1 ? '' : 's'}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
                    {r.reserve_cents != null && <span className={resMet ? 'text-emerald-400' : 'text-amber-400'}>{resMet ? 'Reserve met' : 'Reserve'}</span>}
                    {r.buy_now_cents != null && <span className="text-emerald-400">Buy now {money(r.buy_now_cents)}</span>}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
