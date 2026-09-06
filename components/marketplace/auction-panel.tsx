'use client';

// The live auction box on a listing detail page. Shows the current bid, a
// ticking countdown, reserve state, proxy-bid input with one-tap quick-bid
// amounts, Buy-It-Now, and a live bid history — all realtime: any bid from
// anyone updates every viewer instantly via Supabase Realtime.
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Gavel, Clock, ShieldCheck, Zap, Loader2, TrendingUp, Flame } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import {
  auctionStatus, isLive, timeLeft, minNextBidCents, reserveMet, quickBidLadder,
  type AuctionListing,
} from '@/lib/marketplace/auction';
import { placeBidAction, buyNowAction } from '@/app/(app)/marketplace/auctions/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

type Bid = { id: string; bidder_family_id: string; amount_cents: number; status: string; created_at: string; is_auto: boolean };

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export function AuctionPanel({
  listingId, isOwner, myFamilyId, initial, initialBids,
}: {
  listingId: string;
  isOwner: boolean;
  myFamilyId: string;
  initial: AuctionListing & { highestBidderFamilyId: string | null };
  initialBids: Bid[];
}) {
  const tr = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [pending, startTransition] = useTransition();
  const [a, setA] = useState(initial);
  const [bids, setBids] = useState<Bid[]>(initialBids);
  const [now, setNow] = useState(() => new Date());
  const [maxInput, setMaxInput] = useState('');

  // Tick the countdown every second.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Realtime: refetch the listing + bids whenever a bid lands or the listing changes.
  const refetch = useRef<() => void>(() => {});
  refetch.current = async () => {
    const sb = createClient();
    const [{ data: l }, { data: b }] = await Promise.all([
      sb.from('marketplace_listings').select('sale_format, status, starting_bid_cents, current_bid_cents, bid_count, reserve_cents, buy_now_cents, auction_starts_at, auction_ends_at, highest_bidder_family_id').eq('id', listingId).maybeSingle(),
      sb.from('marketplace_bids').select('id, bidder_family_id, amount_cents, status, created_at, is_auto').eq('listing_id', listingId).order('created_at', { ascending: false }).limit(20),
    ]);
    if (l) setA({
      saleFormat: l.sale_format, status: l.status, startingBidCents: l.starting_bid_cents,
      currentBidCents: l.current_bid_cents, bidCount: l.bid_count, reserveCents: l.reserve_cents,
      buyNowCents: l.buy_now_cents, auctionStartsAt: l.auction_starts_at, auctionEndsAt: l.auction_ends_at,
      highestBidderFamilyId: l.highest_bidder_family_id,
    });
    if (b) setBids(b as Bid[]);
  };
  useEffect(() => {
    const sb = createClient();
    const ch = sb.channel(`auction:${listingId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'marketplace_bids', filter: `listing_id=eq.${listingId}` }, () => refetch.current())
      .subscribe();
    return () => { void sb.removeChannel(ch); };
  }, [listingId]);

  const status = auctionStatus(a, now);
  const live = isLive(a, now);
  const iLead = a.highestBidderFamilyId === myFamilyId;
  const minNext = minNextBidCents(a);
  const ladder = useMemo(() => quickBidLadder(a), [a]);
  const resMet = reserveMet(a);

  function bid(maxCents: number) {
    if (isOwner) return;
    startTransition(async () => {
      const res = await placeBidAction({ listingId, maxCents });
      if (!res.ok) { toastError(res.error); return; }
      setMaxInput('');
      success(res.data?.leading
        ? (res.data.extended ? 'You’re the top bidder — clock extended!' : 'You’re the top bidder! 🎉')
        : 'Bid placed — but you were outbid by a proxy bid. Raise your max to lead.');
      refetch.current();
      router.refresh();
    });
  }

  function buyNow() {
    if (isOwner) return;
    startTransition(async () => {
      const res = await buyNowAction(listingId);
      if (!res.ok) { toastError(res.error); return; }
      success('Bought! Check your orders to arrange pickup.');
      router.refresh();
    });
  }

  const toneRing = status === 'ending_soon' ? 'border-rose-500/40' : 'border-brand/30';

  return (
    <div className={cn('rounded-2xl border-2 bg-gradient-to-br from-brand/[0.07] to-surface/40 p-5', toneRing)}>
      <div className="mb-3 flex items-center gap-2 text-sm font-bold">
        <Gavel className="h-4 w-4 text-brand-text" /> {tr('auction.auction')}
        {status === 'ending_soon' && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-bold text-rose-400">
            <Flame className="h-3 w-3" /> {tr('auction.endingSoon')}
          </span>
        )}
        {status === 'scheduled' && <span className="ml-auto text-xs font-semibold text-muted">{tr('auction.startsSoon')}</span>}
      </div>

      {/* Current bid + countdown */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted">{a.bidCount > 0 ? 'Current bid' : 'Starting bid'}</p>
          <p className="text-3xl font-black tabular-nums">{money(a.bidCount > 0 ? a.currentBidCents : a.startingBidCents)}</p>
          <p className="mt-0.5 text-xs text-muted">
            {a.bidCount} bid{a.bidCount === 1 ? '' : 's'}
            {a.reserveCents != null && (
              <span className={cn('ml-2 font-semibold', resMet ? 'text-emerald-400' : 'text-amber-400')}>
                · {resMet ? 'Reserve met' : 'Reserve not met'}
              </span>
            )}
          </p>
        </div>
        <div className="text-right">
          <p className="flex items-center justify-end gap-1 text-[11px] uppercase tracking-wide text-muted"><Clock className="h-3 w-3" /> {status === 'ended' ? 'Closed' : 'Time left'}</p>
          <p className={cn('text-xl font-bold tabular-nums', status === 'ending_soon' ? 'text-rose-400' : 'text-fg')}>
            {status === 'ended' ? 'Ended' : timeLeft(a.auctionEndsAt, now)}
          </p>
          {iLead && live && <p className="mt-0.5 text-xs font-bold text-emerald-400">{tr('auction.youreWinning')}</p>}
        </div>
      </div>

      {/* Bid controls */}
      {live && !isOwner && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {ladder.map((amt) => (
              <button key={amt} onClick={() => bid(amt)} disabled={pending}
                className="rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold transition hover:border-brand/40 hover:bg-elevated disabled:opacity-50">
                {money(amt)}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
              <input
                type="number" inputMode="decimal" min={minNext / 100} step="0.01"
                value={maxInput} onChange={(e) => setMaxInput(e.target.value)}
                placeholder={`Max bid (min ${money(minNext)})`}
                className="h-11 w-full rounded-xl border border-border bg-bg pl-7 pr-3 text-sm outline-none focus:border-brand"
              />
            </div>
            <button
              onClick={() => { const c = Math.round(parseFloat(maxInput) * 100); if (Number.isFinite(c)) bid(c); }}
              disabled={pending || !maxInput}
              className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-50">
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingUp className="h-4 w-4" />} Bid
            </button>
          </div>
          <p className="flex items-center gap-1 text-[11px] text-muted">
            <ShieldCheck className="h-3 w-3" /> {tr('auction.enterYourMaxWeBidThe')}
          </p>
          {a.buyNowCents != null && (
            <button onClick={buyNow} disabled={pending}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 py-2.5 text-sm font-bold text-emerald-400 transition hover:bg-emerald-500/20 disabled:opacity-50">
              <Zap className="h-4 w-4" /> {tr('auction.buyItNowFor')} {money(a.buyNowCents)}
            </button>
          )}
        </div>
      )}

      {isOwner && live && (
        <p className="mt-4 rounded-xl border border-border bg-surface/50 p-3 text-xs text-muted">
          {tr('auction.thisIsYourFamilysAuctionSit')}
        </p>
      )}
      {status === 'ended' && (
        <p className="mt-4 rounded-xl border border-border bg-surface/50 p-3 text-sm font-semibold">
          {a.bidCount === 0 ? 'Ended with no bids.'
            : resMet ? `Sold for ${money(a.currentBidCents)}.`
            : `Ended at ${money(a.currentBidCents)} — reserve not met.`}
        </p>
      )}

      {/* Bid history */}
      {bids.length > 0 && (
        <div className="mt-4 border-t border-border/50 pt-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{tr('auction.bidHistory')}</p>
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {bids.map((b) => (
              <li key={b.id} className="flex items-center justify-between text-xs">
                <span className="text-muted">
                  {b.bidder_family_id === myFamilyId ? 'You' : 'A bidder'}{b.is_auto ? ' (auto)' : ''}
                  {b.status === 'outbid' && <span className="ml-1 text-rose-400/70">outbid</span>}
                </span>
                <span className="font-semibold tabular-nums">{money(b.amount_cents)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
