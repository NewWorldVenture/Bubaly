import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, UserCheck, Sparkles } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SaveButton } from '@/components/marketplace/save-button';
import { buildFollowingFeed, newFromFollowingCount, type FeedListing, type StoreRow } from '@/lib/marketplace/following';
import { KIND_LABELS, priceLabel, type ListingKind, type RentPeriod } from '@/lib/marketplace/listings';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Following · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function MarketplaceFollowingPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const meId = ctx.active.member.id;
  const dataWarnings: string[] = [];

  const [{ data: follows, error: followsError }, { data: saves, error: savesError }] = await settleAll([
    sb.from('marketplace_follows').select('store_id').eq('family_id', familyId).eq('member_id', meId),
    sb.from('marketplace_saves').select('listing_id').eq('family_id', familyId).eq('member_id', meId),
  ]);

  if (followsError) {
    console.error('[marketplace-following] Follows read failed', followsError);
    return <ErrorState message={t('following.couldNotLoadTheCreators')} />;
  }
  if (savesError) {
    console.error('[marketplace-following] Saved listings read failed', savesError);
    dataWarnings.push('Saved listings');
  }

  const storeIds = (follows ?? []).map((f) => f.store_id);
  const { data: stores, error: storesError } = storeIds.length
    ? await sb.from('marketplace_stores').select('id, member_id, name, emoji, is_active').in('id', storeIds)
    : { data: [] as StoreRow[], error: null };
  if (storesError) {
    console.error('[marketplace-following] Stores read failed', storesError);
    dataWarnings.push('Stores');
  }

  const memberIds = [...new Set((stores ?? []).map((s) => s.member_id))];
  const { data: listings, error: listingsError } = memberIds.length
    ? await sb.from('marketplace_listings')
        .select('id, member_id, title, kind, price_cents, rent_period, status, created_at')
        .eq('family_id', familyId).in('member_id', memberIds).order('created_at', { ascending: false }).limit(200)
    : { data: [] as FeedListing[], error: null };
  if (listingsError) {
    console.error('[marketplace-following] Listings read failed', listingsError);
    dataWarnings.push('Listings');
  }

  const feed = buildFollowingFeed((follows ?? []), (stores ?? []) as StoreRow[], (listings ?? []) as FeedListing[]);
  const newCount = newFromFollowingCount(feed);
  const savedIds = new Set((saves ?? []).map((s) => s.listing_id));

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('marketplaceFollowing.following')}
        description={t('following.theLatestFromTheCreators')}
      />

      {dataWarnings.length > 0 && (
        <div role="status" aria-label={t('marketplaceFollowing.marketplaceFollowingDataHealth')} className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{t('marketplaceFollowing.someFollowingDetailsAreTemporarilyUnavailable')} {dataWarnings.join(', ')}.</p>
        </div>
      )}

      {storeIds.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-8 text-center text-sm text-muted">
          <UserCheck className="mx-auto mb-2 h-6 w-6" />
          {t('marketplaceFollowing.youreNotFollowingAnyoneYet')}
          <div className="mt-2"><Link href="/marketplace/creators" className="text-brand-text hover:underline">{t('marketplaceFollowing.findCreatorsToFollow')}</Link></div>
        </div>
      ) : feed.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-8 text-center text-sm text-muted">
          {t('marketplaceFollowing.nothingNewFromYourFollowedCreators')}
        </div>
      ) : (
        <>
          {newCount > 0 && (
            <p className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-3 py-1 text-xs font-medium text-brand-text">
              <Sparkles className="h-3.5 w-3.5" /> {newCount} {t('marketplaceFollowing.newThisWeek')}
            </p>
          )}
          <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {feed.map(({ listing: l, storeName, storeEmoji, isNew }) => {
              const price = priceLabel(l.kind as ListingKind, l.price_cents, (l.rent_period ?? null) as RentPeriod | null);
              return (
                <li key={l.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface/60 p-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="mb-0.5 flex items-center gap-1 text-[11px] text-muted">
                      <span>{storeEmoji ?? '🛍️'}</span> <span className="truncate">{storeName}</span>
                    </p>
                    <Link href={`/marketplace/item/${l.id}`} className="line-clamp-2 text-sm font-medium hover:text-brand-text">
                      {l.title}
                      {isNew && <span className="ml-1.5 rounded bg-brand/15 px-1 py-0.5 align-middle text-[10px] font-semibold text-brand-text">NEW</span>}
                    </Link>
                    <p className="mt-1 text-xs text-muted">
                      {KIND_LABELS[l.kind as ListingKind] ?? l.kind}{price && ` · ${price}`}
                    </p>
                  </div>
                  <SaveButton listingId={l.id} saved={savedIds.has(l.id)} />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
