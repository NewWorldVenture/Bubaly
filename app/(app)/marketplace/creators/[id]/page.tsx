import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft, Star, ShieldCheck, Users, Package, Tag, MapPin,
  ShoppingBag, Clock, Gift, HelpCircle, Repeat, HandHeart,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Avatar } from '@/components/ui/avatar';
import { FollowButton } from '@/components/marketplace/follow-button';
import { ListingImage } from '@/components/marketplace/listing-image';
import { computeTrustScore, ratingSummary, TRUST_BAND_LABELS } from '@/lib/marketplace/trust';
import {
  KIND_LABELS, CATEGORY_LABELS, priceLabel,
  type ListingKind, type ListingCategory, type RentPeriod,
} from '@/lib/marketplace/listings';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Storefront · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

const KIND_ICON: Record<string, typeof ShoppingBag> = {
  sell: ShoppingBag, rent: Clock, borrow: Package, free: Gift,
  wanted: HelpCircle, swap: Repeat, donate: HandHeart,
};

export default async function StorefrontPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const selfId = ctx.active.member.id;

  const { data: store } = await sb
    .from('marketplace_stores')
    .select('id, member_id, name, tagline, description, emoji, is_active')
    .eq('id', id).eq('family_id', familyId).eq('is_active', true).maybeSingle();
  if (!store) notFound();

  const { data: members } = await sb.from('family_members').select('id, display_name').eq('family_id', familyId);
  const ownerName = members?.find((m) => m.id === store.member_id)?.display_name ?? 'A neighbor';
  const nameOf = (mid: string | null) => members?.find((m) => m.id === mid)?.display_name ?? 'Someone';
  const isOwner = store.member_id === selfId;

  const [reviewsRes, listingsRes, followRes, selfFollowRes, ordersRes, listingCountRes] = await Promise.all([
    sb.from('marketplace_reviews').select('id, reviewer_member, rating, comment, created_at').eq('family_id', familyId).eq('reviewee_member', store.member_id).order('created_at', { ascending: false }).limit(12),
    sb.from('marketplace_listings').select('id, title, kind, category, price_cents, rent_period, photo_url, location, status').eq('family_id', familyId).eq('member_id', store.member_id).in('status', ['available', 'pending']).order('created_at', { ascending: false }).limit(24),
    sb.from('marketplace_follows').select('id', { count: 'exact', head: true }).eq('store_id', store.id),
    sb.from('marketplace_follows').select('id').eq('store_id', store.id).eq('member_id', selfId).maybeSingle(),
    sb.from('marketplace_orders').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('seller_member', store.member_id).eq('status', 'completed'),
    sb.from('marketplace_listings').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('member_id', store.member_id),
  ]);

  const ratings = (reviewsRes.data ?? []).map((r) => r.rating);
  const rs = ratingSummary(ratings);
  const trust = computeTrustScore({
    ratingsReceived: ratings,
    ordersCompleted: ordersRes.count ?? 0,
    listingsPosted: listingCountRes.count ?? 0,
  });
  const followers = followRes.count ?? 0;
  const listings = listingsRes.data ?? [];
  const reviews = reviewsRes.data ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/marketplace/creators" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> All creators
      </Link>

      {/* Storefront header */}
      <div className="rounded-2xl border border-border bg-gradient-to-br from-surface to-surface/40 p-5">
        <div className="flex items-start gap-4">
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-elevated text-3xl">{store.emoji ?? '🛍️'}</span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold text-fg">{store.name}</h1>
            {store.tagline && <p className="mt-0.5 text-sm text-muted">{store.tagline}</p>}
            <div className="mt-2 flex items-center gap-2 text-xs text-muted">
              <Avatar name={ownerName} size={18} /> {ownerName}{isOwner && ' (you)'}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            {isOwner ? (
              <Link href="/marketplace/store" className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-fg">Edit store</Link>
            ) : (
              <FollowButton storeId={store.id} following={!!selfFollowRes.data} />
            )}
          </div>
        </div>

        {store.description && <p className="mt-4 whitespace-pre-wrap text-sm text-fg/90">{store.description}</p>}

        {/* Stats row */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />} value={String(trust.score)} label={TRUST_BAND_LABELS[trust.band]} />
          <Stat icon={<Star className="h-4 w-4 fill-amber-400 text-amber-400" />} value={rs.count > 0 ? rs.avg.toFixed(1) : '—'} label={rs.count > 0 ? `${rs.count} review${rs.count === 1 ? '' : 's'}` : 'No reviews'} />
          <Stat icon={<Users className="h-4 w-4 text-brand-text" />} value={String(followers)} label={`follower${followers === 1 ? '' : 's'}`} />
          <Stat icon={<Package className="h-4 w-4 text-muted" />} value={String(listings.length)} label="open listings" />
        </div>
      </div>

      {/* Listings */}
      <h2 className="mb-3 mt-8 text-sm font-semibold text-fg">Listings</h2>
      {listings.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface/40 p-8 text-center text-sm text-muted">
          Nothing on offer right now.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((l) => {
            const kind = l.kind as ListingKind;
            const KindIcon = KIND_ICON[kind] ?? ShoppingBag;
            const price = priceLabel(kind, l.price_cents, l.rent_period as RentPeriod | null);
            return (
              <Link key={l.id} href={`/marketplace/item/${l.id}`} className="group flex flex-col overflow-hidden rounded-xl border border-border bg-surface/60 transition hover:border-brand/40">
                <ListingImage
                  src={l.photo_url}
                  alt={l.title}
                  className="h-32 w-full object-cover transition group-hover:opacity-90"
                  fallback={
                    <div className="flex h-32 w-full items-center justify-center bg-gradient-to-br from-surface to-border">
                      <KindIcon className="h-7 w-7 text-muted" />
                    </div>
                  }
                />
                <div className="flex flex-1 flex-col p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
                      <KindIcon className="h-3 w-3" />{KIND_LABELS[kind]}
                    </span>
                    {price && <span className="text-sm font-semibold text-fg">{price}</span>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm font-medium text-fg group-hover:text-brand-text">{l.title}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                    <span className="inline-flex items-center gap-1"><Tag className="h-3 w-3" />{CATEGORY_LABELS[l.category as ListingCategory]}</span>
                    {l.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{l.location}</span>}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Reviews */}
      {reviews.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-fg">What people say</h2>
          <ul className="space-y-3">
            {reviews.map((r) => (
              <li key={r.id} className="rounded-xl border border-border bg-surface/50 p-3">
                <div className="flex items-center gap-2">
                  <Avatar name={nameOf(r.reviewer_member)} size={24} />
                  <span className="text-sm font-medium text-fg">{nameOf(r.reviewer_member)}</span>
                  <span className={cn('ml-auto inline-flex items-center gap-0.5 text-xs text-amber-400')}>
                    {Array.from({ length: r.rating }).map((_, i) => <Star key={i} className="h-3.5 w-3.5 fill-amber-400" />)}
                  </span>
                </div>
                {r.comment && <p className="mt-1.5 text-sm text-muted">{r.comment}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface/60 p-3 text-center">
      <div className="flex items-center justify-center gap-1 text-lg font-semibold text-fg">{icon}{value}</div>
      <div className="mt-0.5 text-[11px] text-muted">{label}</div>
    </div>
  );
}
