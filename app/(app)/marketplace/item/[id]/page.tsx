import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft, Tag, MapPin, Star, ShieldCheck, Clock, Package, Gift, HelpCircle,
  ShoppingBag, Repeat, HandHeart, Store as StoreIcon, AlertTriangle,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Avatar } from '@/components/ui/avatar';
import { SaveButton } from '@/components/marketplace/save-button';
import { InterestButton } from '@/components/marketplace/interest-button';
import { ListingQuestions } from '@/components/marketplace/listing-questions';
import { ListingImage } from '@/components/marketplace/listing-image';
import { OfferInbox } from '@/components/marketplace/offer-inbox';
import { AuctionPanel } from '@/components/marketplace/auction-panel';
import { NegotiationPanel, type Thread } from '@/components/marketplace/negotiation-panel';
import { priceDropBadge, isAtLowest, historyLine, type PriceChange } from '@/lib/marketplace/price-history';
import { ReportButton } from '@/components/marketplace/report-button';
import { priceBand, assessPrice, dealLabel, bandSummary, type Comp } from '@/lib/marketplace/price-coach';
import { computeTrustScore, ratingSummary, TRUST_BAND_LABELS } from '@/lib/marketplace/trust';
import {
  KIND_LABELS, CATEGORY_LABELS, CONDITION_LABELS, priceLabel, formatCents,
  type ListingKind, type ListingCategory, type RentPeriod,
} from '@/lib/marketplace/listings';
import { cn } from '@/lib/utils/cn';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Listing · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

const KIND_ICON: Record<string, typeof ShoppingBag> = {
  sell: ShoppingBag, rent: Clock, borrow: Package, free: Gift,
  wanted: HelpCircle, swap: Repeat, donate: HandHeart,
};

export default async function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations();
  const { id } = await params;
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const selfId = ctx.active.member.id;
  const dataWarnings: string[] = [];
  const reportRead = (label: string, error: { message?: string | null } | null | undefined) => {
    if (!error) return;
    console.error(`[marketplace-item] ${label} read failed`, error);
    dataWarnings.push(label);
  };

  const { data: listing, error: listingError } = await sb
    .from('marketplace_listings')
    .select('id, member_id, title, description, kind, category, condition, price_cents, rent_period, photo_url, location, status, created_at, sale_format, auction_starts_at, auction_ends_at, starting_bid_cents, reserve_cents, buy_now_cents, current_bid_cents, bid_count, highest_bidder_family_id')
    .eq('id', id).eq('family_id', familyId).maybeSingle();
  if (listingError) {
    reportRead('Listing', listingError);
    return <ErrorState message={t('item.couldNotLoadThisListing')} />;
  }
  if (!listing) notFound();

  const isAuctionListing = listing.sale_format === 'auction';
  const { data: bidRows, error: bidsError } = isAuctionListing
    ? await sb.from('marketplace_bids').select('id, bidder_family_id, amount_cents, status, created_at, is_auto')
        .eq('listing_id', id).order('created_at', { ascending: false }).limit(20)
    : { data: [], error: null };
  reportRead('Auction bids', bidsError);

  const kind = listing.kind as ListingKind;
  const KindIcon = KIND_ICON[kind] ?? ShoppingBag;
  const isOwner = listing.member_id === selfId;
  const sellerId = listing.member_id ?? '';
  const price = priceLabel(kind, listing.price_cents, listing.rent_period as RentPeriod | null);

  // Seller identity + a trust score computed from real activity.
  const { data: members, error: membersError } = await sb.from('family_members').select('id, display_name').eq('family_id', familyId);
  reportRead('Family members', membersError);
  const sellerName = members?.find((m) => m.id === listing.member_id)?.display_name ?? 'A neighbor';

  const [sellerReviewsRes, listingReviewsRes, saveRes, offerRes, sellerListingsRes, sellerOrdersRes, storeRes] = await Promise.all([
    sb.from('marketplace_reviews').select('rating').eq('family_id', familyId).eq('reviewee_member', sellerId),
    sb.from('marketplace_reviews').select('id, reviewer_member, rating, comment, created_at').eq('family_id', familyId).eq('listing_id', id).order('created_at', { ascending: false }).limit(10),
    sb.from('marketplace_saves').select('id').eq('listing_id', id).eq('member_id', selfId).maybeSingle(),
    sb.from('marketplace_offers').select('id, member_id, kind, amount_cents, message, created_at').eq('listing_id', id).eq('status', 'open').order('created_at', { ascending: true }),
    sb.from('marketplace_listings').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('member_id', sellerId),
    sb.from('marketplace_orders').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('seller_member', sellerId).eq('status', 'completed'),
    listing.member_id
      ? sb.from('marketplace_stores').select('id, name, emoji').eq('family_id', familyId).eq('member_id', listing.member_id).eq('is_active', true).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  reportRead('Seller reviews', sellerReviewsRes.error);
  reportRead('Listing reviews', listingReviewsRes.error);
  reportRead('Saved state', saveRes.error);
  reportRead('Open offers', offerRes.error);
  reportRead('Seller listings', sellerListingsRes.error);
  reportRead('Seller orders', sellerOrdersRes.error);
  reportRead('Seller store', storeRes.error);

  const sellerRatings = (sellerReviewsRes.data ?? []).map((r) => r.rating);
  const trust = computeTrustScore({
    ratingsReceived: sellerRatings,
    ordersCompleted: sellerOrdersRes.count ?? 0,
    listingsPosted: sellerListingsRes.count ?? 0,
  });
  const rs = ratingSummary(sellerRatings);
  const openOfferRows = offerRes.data ?? [];
  const openOffers = openOfferRows.length;
  const alreadySent = openOfferRows.some((o) => o.member_id === selfId);
  const alreadySaved = !!saveRes.data;
  const store = storeRes.data as { id: string; name: string; emoji: string | null } | null;
  const nameOf = (mid: string | null) => members?.find((m) => m.id === mid)?.display_name ?? 'Someone';

  // Pre-format the owner's offer inbox (server-side) so the client panel stays dumb.
  const OFFER_KIND_LABEL: Record<string, string> = { interest: 'Interested', claim: 'Claim', offer: 'Offer' };
  const inboxOffers = isOwner
    ? openOfferRows.map((o) => ({
        id: o.id,
        name: nameOf(o.member_id),
        kindLabel: OFFER_KIND_LABEL[o.kind] ?? 'Offer',
        amount: o.amount_cents ? formatCents(o.amount_cents) : '',
        message: o.message ?? '',
      }))
    : [];

  const claimLabel = kind === 'sell' || kind === 'rent' ? "I'm interested" : kind === 'wanted' ? 'I have this' : 'Claim it';
  const sentLabel = kind === 'sell' || kind === 'rent' ? 'Interest sent' : 'Claim sent';
  const open = listing.status === 'available' || listing.status === 'pending';

  // Price history + drop watch (fixed-price listings with a real price).
  const tracksPrice = !isAuctionListing && listing.price_cents > 0;
  const { data: priceRows, error: priceHistoryError } = tracksPrice
    ? await sb.from('marketplace_price_history')
        .select('old_cents, new_cents, changed_at').eq('listing_id', id)
        .order('changed_at', { ascending: false }).limit(8)
    : { data: [], error: null };
  reportRead('Price history', priceHistoryError);
  const priceHistory: PriceChange[] = (priceRows ?? []).map((r) => ({
    oldCents: r.old_cents, newCents: r.new_cents, changedAt: r.changed_at,
  }));
  const dropBadge = priceDropBadge(priceHistory, listing.price_cents);
  const atLowest = isAtLowest(priceHistory, listing.price_cents);

  // Price coach: "is this a fair price?" from reachable category comps (sell only).
  let dealBadge: { text: string; tone: 'ok' | 'good' | 'muted' | 'warn' } | null = null;
  let compBand: string | null = null;
  if (tracksPrice && kind === 'sell' && !isOwner) {
    const { data: compRows, error: compsError } = await sb
      .from('marketplace_listings')
      .select('category, condition, price_cents, kind')
      .eq('kind', 'sell').eq('category', listing.category).gt('price_cents', 0).neq('id', id)
      .limit(80);
    reportRead('Comparable listings', compsError);
    const comps: Comp[] = (compRows ?? []).map((c) => ({
      category: c.category, condition: c.condition, priceCents: c.price_cents, kind: c.kind,
    }));
    const band = priceBand(listing.category, listing.condition, comps);
    dealBadge = dealLabel(assessPrice(listing.price_cents, band));
    compBand = bandSummary(band);
  }

  // "Make an Offer" negotiation threads (fixed-price sale listings only).
  const negotiable = !isAuctionListing && kind === 'sell' && listing.price_cents > 0;
  let negThreads: Thread[] = [];
  if (negotiable) {
    const { data: negRows, error: negotiationsError } = await sb
      .from('marketplace_negotiations')
      .select('id, buyer_member_id, status, current_amount_cents, last_actor, agreed_amount_cents')
      .eq('listing_id', id).order('created_at', { ascending: true });
    reportRead('Negotiations', negotiationsError);
    const visible = (negRows ?? []).filter((n) =>
      isOwner ? ['open', 'agreed'].includes(n.status) : n.buyer_member_id === selfId && n.status === 'open');
    const negIds = visible.map((n) => n.id);
    const { data: roundRows, error: roundsError } = negIds.length
      ? await sb.from('marketplace_negotiation_rounds')
          .select('id, negotiation_id, actor_role, kind, amount_cents, message, created_at')
          .in('negotiation_id', negIds).order('created_at', { ascending: true })
      : { data: [], error: null };
    reportRead('Negotiation rounds', roundsError);
    negThreads = visible.map((n) => ({
      id: n.id,
      buyerName: nameOf(n.buyer_member_id),
      status: n.status,
      currentAmountCents: n.current_amount_cents,
      lastActor: n.last_actor as 'buyer' | 'seller',
      agreedAmountCents: n.agreed_amount_cents,
      rounds: (roundRows ?? []).filter((r) => r.negotiation_id === n.id).map((r) => ({
        id: r.id, actorRole: r.actor_role as 'buyer' | 'seller', kind: r.kind as Thread['rounds'][number]['kind'],
        amountCents: r.amount_cents, message: r.message, createdAt: r.created_at,
      })),
    }));
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      {dataWarnings.length > 0 && (
        <div
          role="status"
          aria-label={t('marketplaceItem.listingDataHealth')}
          className="mb-4 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> {t('marketplaceItem.someListingDetailsAreTemporarilyUnavailable')}</p>
          <p className="mt-1 text-xs">{t('item.theListingIsStillShown')}</p>
          <p className="mt-1 text-xs">Unavailable: {Array.from(new Set(dataWarnings)).join(', ')}.</p>
        </div>
      )}
      <Link href="/marketplace/browse" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> {t('marketplaceItem.backToBrowse')}
      </Link>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Photo */}
        <div className="overflow-hidden rounded-2xl border border-border bg-surface/50">
          <ListingImage
            src={listing.photo_url}
            alt={listing.title}
            className="aspect-[4/3] w-full object-cover"
            fallback={
              <div className="flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-br from-surface to-border">
                <KindIcon className="h-12 w-12 text-muted" />
              </div>
            }
          />
        </div>

        {/* Details */}
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted">
              <KindIcon className="h-3 w-3" /> {KIND_LABELS[kind]}
            </span>
            <span className={cn('text-xs capitalize', listing.status === 'available' ? 'text-emerald-500' : 'text-muted')}>{listing.status}</span>
          </div>

          <h1 className="mt-2 text-2xl font-semibold text-fg">{listing.title}</h1>
          {!isAuctionListing && price && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-xl font-bold text-fg">{price}</span>
              {dropBadge && (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-bold text-rose-600 dark:text-rose-400">
                  ↓ {dropBadge}
                </span>
              )}
              {atLowest && priceHistory.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                  {t('marketplaceItem.lowestEver')}
                </span>
              )}
              {dealBadge && (
                <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold',
                  dealBadge.tone === 'ok' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : dealBadge.tone === 'good' ? 'bg-sky-500/12 text-sky-600 dark:text-sky-400'
                  : dealBadge.tone === 'warn' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-border/60 text-muted')}
                  title={compBand ?? undefined}>
                  {dealBadge.text}
                </span>
              )}
            </div>
          )}
          {compBand && <p className="mt-0.5 text-[11px] text-muted">{compBand} {t('marketplaceItem.basedOnComparableListings')}</p>}
          {tracksPrice && priceHistory.length > 0 && (
            <details className="mt-2 text-xs text-muted">
              <summary className="cursor-pointer select-none hover:text-fg">{t('marketplaceItem.priceHistory')}{priceHistory.length})</summary>
              <ul className="mt-1.5 space-y-0.5">
                {priceHistory.map((h, i) => (
                  <li key={i} className="flex items-center justify-between gap-3">
                    <span className={h.newCents < h.oldCents ? 'text-rose-500 dark:text-rose-400' : 'text-muted'}>{historyLine(h)}</span>
                    <span className="tabular-nums">{new Date(h.changedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* Live auction box (replaces the fixed price when this is an auction) */}
          {isAuctionListing && (
            <div className="mt-4">
              <AuctionPanel
                listingId={listing.id}
                isOwner={isOwner}
                myFamilyId={familyId}
                initial={{
                  saleFormat: listing.sale_format, status: listing.status,
                  startingBidCents: listing.starting_bid_cents, currentBidCents: listing.current_bid_cents,
                  bidCount: listing.bid_count, reserveCents: listing.reserve_cents, buyNowCents: listing.buy_now_cents,
                  auctionStartsAt: listing.auction_starts_at, auctionEndsAt: listing.auction_ends_at,
                  highestBidderFamilyId: listing.highest_bidder_family_id,
                }}
                initialBids={(bidRows ?? []) as never}
              />
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span className="inline-flex items-center gap-1"><Tag className="h-4 w-4" />{CATEGORY_LABELS[listing.category as ListingCategory]}</span>
            {listing.condition && <span>{CONDITION_LABELS[listing.condition as keyof typeof CONDITION_LABELS]}</span>}
            {listing.location && <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" />{listing.location}</span>}
          </div>

          {listing.description && <p className="mt-4 whitespace-pre-wrap text-sm text-fg/90">{listing.description}</p>}

          {/* Seller / trust card */}
          <div className="mt-5 rounded-xl border border-border bg-surface/50 p-4">
            <div className="flex items-center gap-3">
              <Avatar name={sellerName} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 font-medium text-fg">
                  {sellerName}{isOwner && <span className="text-xs text-muted">(you)</span>}
                </div>
                {store && (
                  <Link href={`/marketplace/creators/${store.id}`} className="inline-flex items-center gap-1 text-xs text-brand-text hover:underline">
                    <StoreIcon className="h-3 w-3" /> {store.emoji ? `${store.emoji} ` : ''}{store.name}
                  </Link>
                )}
              </div>
              <div className="text-right">
                <div className="inline-flex items-center gap-1 text-sm font-semibold text-fg">
                  <ShieldCheck className="h-4 w-4 text-emerald-500" /> {trust.score}
                </div>
                <div className="text-[11px] text-muted">{TRUST_BAND_LABELS[trust.band]}</div>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs text-muted">
              {rs.count > 0 ? (
                <span className="inline-flex items-center gap-1"><Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />{rs.avg.toFixed(1)} ({rs.count})</span>
              ) : (
                <span>{t('marketplaceItem.noReviewsYet')}</span>
              )}
              {trust.factors[0] && <span className="truncate">· {trust.factors[0]}</span>}
            </div>
          </div>

          {/* Actions */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {isOwner ? (
              <span className="text-sm text-muted">{t('marketplaceItem.thisIsYourListing')}{openOffers > 0 ? ` · ${openOffers} open offer${openOffers === 1 ? '' : 's'}` : ''}.</span>
            ) : open ? (
              <InterestButton listingId={listing.id} label={claimLabel} sentLabel={sentLabel} alreadySent={alreadySent} />
            ) : (
              <span className="text-sm text-muted capitalize">{listing.status}</span>
            )}
            <SaveButton listingId={listing.id} saved={alreadySaved}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg" />
            {!isOwner && <ReportButton listingId={listing.id} />}
          </div>

          {/* Owner: accept / decline the offers on this listing */}
          {isOwner && inboxOffers.length > 0 && (
            <OfferInbox offers={inboxOffers} />
          )}

          {/* Make an Offer — Best Offer negotiation (fixed-price sales) */}
          {negotiable && (isOwner || open) && (
            <div className="mt-5">
              <NegotiationPanel
                listingId={listing.id}
                askCents={listing.price_cents}
                isOwner={isOwner}
                canOffer={!isOwner && open}
                threads={negThreads}
              />
            </div>
          )}
        </div>
      </div>

      {/* Reviews for this listing */}
      {(listingReviewsRes.data ?? []).length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-fg">{t('marketplaceItem.reviews')}</h2>
          <ul className="space-y-3">
            {(listingReviewsRes.data ?? []).map((r) => (
              <li key={r.id} className="rounded-xl border border-border bg-surface/50 p-3">
                <div className="flex items-center gap-2">
                  <Avatar name={nameOf(r.reviewer_member)} size={24} />
                  <span className="text-sm font-medium text-fg">{nameOf(r.reviewer_member)}</span>
                  <span className="ml-auto inline-flex items-center gap-0.5 text-xs text-amber-400">
                    {Array.from({ length: r.rating }).map((_, i) => <Star key={i} className="h-3.5 w-3.5 fill-amber-400" />)}
                  </span>
                </div>
                {r.comment && <p className="mt-1.5 text-sm text-muted">{r.comment}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Q&A */}
      <ListingQuestions listingId={listing.id} isOwner={isOwner} />
    </div>
  );
}
