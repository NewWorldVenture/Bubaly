import type { Metadata } from 'next';
import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { StoreForm } from '@/components/marketplace/store-form';
import { ratingSummary } from '@/lib/marketplace/trust';
import { KIND_LABELS, priceLabel, type ListingKind, type RentPeriod } from '@/lib/marketplace/listings';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'My Store · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function MarketplaceStorePage() {
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const selfId = ctx.active.member.id;

  const { data: store } = await sb
    .from('marketplace_stores')
    .select('id, name, tagline, description, emoji')
    .eq('family_id', familyId)
    .eq('member_id', selfId)
    .maybeSingle();

  const [{ count: followers }, { data: reviews }, { data: myListings }] = await Promise.all([
    store
      ? sb.from('marketplace_follows').select('id', { count: 'exact', head: true }).eq('store_id', store.id)
      : Promise.resolve({ count: 0 } as { count: number | null }),
    sb.from('marketplace_reviews').select('rating').eq('family_id', familyId).eq('reviewee_member', selfId).limit(500),
    sb.from('marketplace_listings')
      .select('id, title, kind, status, price_cents, rent_period, created_at')
      .eq('family_id', familyId).eq('member_id', selfId)
      .order('created_at', { ascending: false }).limit(100),
  ]);

  const rating = ratingSummary((reviews ?? []).map((r) => r.rating));

  return (
    <div>
      <PageHeader
        title="My Store"
        description="Your storefront on the family marketplace — brand your listings and build a following."
      />

      {store && (
        <div className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-brand/25 bg-brand/[0.04] p-4">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-elevated text-2xl">{store.emoji ?? '🛍️'}</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{store.name}</p>
            {store.tagline && <p className="text-xs text-muted">{store.tagline}</p>}
          </div>
          <div className="flex gap-4 text-center">
            <div><p className="text-sm font-bold">{followers ?? 0}</p><p className="text-[10px] text-muted">followers</p></div>
            <div><p className="text-sm font-bold">{rating.count > 0 ? `★ ${rating.avg.toFixed(1)}` : '—'}</p><p className="text-[10px] text-muted">{rating.count} reviews</p></div>
            <div><p className="text-sm font-bold">{(myListings ?? []).length}</p><p className="text-[10px] text-muted">listings</p></div>
          </div>
        </div>
      )}

      <StoreForm initial={store ? { name: store.name, tagline: store.tagline ?? '', description: store.description ?? '', emoji: store.emoji ?? '' } : null} />

      <section id="listings" className="mt-6">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><ListChecks className="h-4 w-4 text-brand-text" /> My Listings</h2>
          <Link href="/marketplace/browse?post=1" className="text-xs text-brand-text hover:underline">Post an item</Link>
        </div>
        {(myListings ?? []).length === 0 ? (
          <p className="rounded-xl border border-border bg-surface/40 p-4 text-sm text-muted">
            Nothing listed yet — your items appear here once you post.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {(myListings ?? []).map((l) => (
              <li key={l.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/60 px-3.5 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm">{l.title}</span>
                <span className="text-xs text-muted">{KIND_LABELS[l.kind as ListingKind] ?? l.kind}</span>
                {priceLabel(l.kind as ListingKind, l.price_cents, l.rent_period as RentPeriod | null) && (
                  <span className="text-xs font-semibold text-brand-text">{priceLabel(l.kind as ListingKind, l.price_cents, l.rent_period as RentPeriod | null)}</span>
                )}
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium',
                  l.status === 'available' ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' : 'bg-border/60 text-muted',
                )}>{l.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
