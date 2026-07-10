import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft, Tag, MapPin, Star, ShieldCheck, Clock, Package, Gift, HelpCircle,
  ShoppingBag, Repeat, HandHeart, Store as StoreIcon,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Avatar } from '@/components/ui/avatar';
import { SaveButton } from '@/components/marketplace/save-button';
import { InterestButton } from '@/components/marketplace/interest-button';
import { ListingQuestions } from '@/components/marketplace/listing-questions';
import { computeTrustScore, ratingSummary, TRUST_BAND_LABELS } from '@/lib/marketplace/trust';
import {
  KIND_LABELS, CATEGORY_LABELS, CONDITION_LABELS, priceLabel, kindHasPrice,
  type ListingKind, type ListingCategory, type RentPeriod,
} from '@/lib/marketplace/listings';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Listing · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

const KIND_ICON: Record<string, typeof ShoppingBag> = {
  sell: ShoppingBag, rent: Clock, borrow: Package, free: Gift,
  wanted: HelpCircle, swap: Repeat, donate: HandHeart,
};

export default async function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const selfId = ctx.active.member.id;

  const { data: listing } = await sb
    .from('marketplace_listings')
    .select('id, member_id, title, description, kind, category, condition, price_cents, rent_period, photo_url, location, status, created_at')
    .eq('id', id).eq('family_id', familyId).maybeSingle();
  if (!listing) notFound();

  const kind = listing.kind as ListingKind;
  const KindIcon = KIND_ICON[kind] ?? ShoppingBag;
  const isOwner = listing.member_id === selfId;
  const sellerId = listing.member_id ?? '';
  const price = priceLabel(kind, listing.price_cents, listing.rent_period as RentPeriod | null);

  // Seller identity + a trust score computed from real activity.
  const { data: members } = await sb.from('family_members').select('id, display_name').eq('family_id', familyId);
  const sellerName = members?.find((m) => m.id === listing.member_id)?.display_name ?? 'A neighbor';

  const [sellerReviewsRes, listingReviewsRes, saveRes, offerRes, sellerListingsRes, sellerOrdersRes, storeRes] = await Promise.all([
    sb.from('marketplace_reviews').select('rating').eq('family_id', familyId).eq('reviewee_member', sellerId),
    sb.from('marketplace_reviews').select('id, reviewer_member, rating, comment, created_at').eq('family_id', familyId).eq('listing_id', id).order('created_at', { ascending: false }).limit(10),
    sb.from('marketplace_saves').select('id').eq('listing_id', id).eq('member_id', selfId).maybeSingle(),
    sb.from('marketplace_offers').select('id', { count: 'exact', head: true }).eq('listing_id', id).eq('status', 'open'),
    sb.from('marketplace_listings').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('member_id', sellerId),
    sb.from('marketplace_orders').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('seller_member', sellerId).eq('status', 'completed'),
    listing.member_id
      ? sb.from('marketplace_stores').select('id, name, emoji').eq('family_id', familyId).eq('member_id', listing.member_id).eq('is_active', true).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const sellerRatings = (sellerReviewsRes.data ?? []).map((r) => r.rating);
  const trust = computeTrustScore({
    ratingsReceived: sellerRatings,
    ordersCompleted: sellerOrdersRes.count ?? 0,
    listingsPosted: sellerListingsRes.count ?? 0,
  });
  const rs = ratingSummary(sellerRatings);
  const openOffers = offerRes.count ?? 0;
  const alreadySaved = !!saveRes.data;
  const store = storeRes.data as { id: string; name: string; emoji: string | null } | null;
  const nameOf = (mid: string | null) => members?.find((m) => m.id === mid)?.display_name ?? 'Someone';

  const claimLabel = kind === 'sell' || kind === 'rent' ? "I'm interested" : kind === 'wanted' ? 'I have this' : 'Claim it';
  const sentLabel = kind === 'sell' || kind === 'rent' ? 'Interest sent' : 'Claim sent';
  const open = listing.status === 'available' || listing.status === 'pending';

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <Link href="/marketplace/browse" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Back to browse
      </Link>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Photo */}
        <div className="overflow-hidden rounded-2xl border border-border bg-surface/50">
          {listing.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={listing.photo_url} alt={listing.title} className="aspect-[4/3] w-full object-cover" />
          ) : (
            <div className="flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-br from-surface to-border">
              <KindIcon className="h-12 w-12 text-muted" />
            </div>
          )}
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
          {price && <div className="mt-1 text-xl font-bold text-fg">{price}</div>}

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
                  <Link href={`/marketplace/creators/${store.id}`} className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
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
                <span>No reviews yet</span>
              )}
              {trust.factors[0] && <span className="truncate">· {trust.factors[0]}</span>}
            </div>
          </div>

          {/* Actions */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {isOwner ? (
              <span className="text-sm text-muted">This is your listing{openOffers > 0 ? ` · ${openOffers} open offer${openOffers === 1 ? '' : 's'}` : ''}.</span>
            ) : open ? (
              <InterestButton listingId={listing.id} label={claimLabel} sentLabel={sentLabel} />
            ) : (
              <span className="text-sm text-muted capitalize">{listing.status}</span>
            )}
            <SaveButton listingId={listing.id} saved={alreadySaved}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg" />
          </div>
        </div>
      </div>

      {/* Reviews for this listing */}
      {(listingReviewsRes.data ?? []).length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-fg">Reviews</h2>
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
