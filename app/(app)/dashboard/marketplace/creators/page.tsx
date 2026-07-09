import type { Metadata } from 'next';
import Link from 'next/link';
import { Users } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { FollowButton } from '@/components/marketplace/follow-button';
import { rankCreators, type CreatorStore } from '@/lib/marketplace/discover';

export const metadata: Metadata = { title: 'Creators · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function MarketplaceCreatorsPage() {
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const selfId = ctx.active.member.id;

  const [{ data: stores }, { data: follows }, { data: reviews }, { data: listings }] = await Promise.all([
    sb.from('marketplace_stores').select('id, member_id, name, tagline, emoji, is_active').eq('family_id', familyId),
    sb.from('marketplace_follows').select('store_id, member_id').eq('family_id', familyId).limit(2000),
    sb.from('marketplace_reviews').select('reviewee_member, rating').eq('family_id', familyId).limit(1000),
    sb.from('marketplace_listings').select('member_id').eq('family_id', familyId).in('status', ['available', 'pending']).limit(1000),
  ]);

  const ratingsByMember = new Map<string, number[]>();
  for (const r of reviews ?? []) {
    if (r.reviewee_member) ratingsByMember.set(r.reviewee_member, [...(ratingsByMember.get(r.reviewee_member) ?? []), r.rating]);
  }
  const followersByStore = new Map<string, number>();
  const selfFollows = new Set<string>();
  for (const f of follows ?? []) {
    followersByStore.set(f.store_id, (followersByStore.get(f.store_id) ?? 0) + 1);
    if (f.member_id === selfId) selfFollows.add(f.store_id);
  }
  const openByMember = new Map<string, number>();
  for (const l of listings ?? []) {
    if (l.member_id) openByMember.set(l.member_id, (openByMember.get(l.member_id) ?? 0) + 1);
  }

  const taglineOf = new Map((stores ?? []).map((s) => [s.id, s.tagline]));
  const ranked = rankCreators((stores ?? []) as CreatorStore[], ratingsByMember, followersByStore);

  return (
    <div>
      <PageHeader title="Creators" description="Verified & trusted sellers — the family storefronts, ranked by rating and following." />
      {ranked.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-8 text-center text-sm text-muted">
          <Users className="mx-auto mb-2 h-6 w-6" />
          No storefronts yet — <Link href="/dashboard/marketplace/store" className="text-brand hover:underline">open the first one</Link>.
        </div>
      ) : (
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {ranked.map((c) => (
            <li key={c.storeId} className="flex items-start gap-3 rounded-xl border border-border bg-surface/60 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-elevated text-xl">{c.emoji ?? '🛍️'}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{c.name}</p>
                {taglineOf.get(c.storeId) && <p className="line-clamp-1 text-xs text-muted">{taglineOf.get(c.storeId)}</p>}
                <p className="mt-1 text-[11px] text-muted">
                  {c.reviewCount > 0 ? `★ ${c.avgRating.toFixed(1)} (${c.reviewCount})` : 'New store'}
                  {c.followerCount > 0 && ` · ${c.followerCount} follower${c.followerCount === 1 ? '' : 's'}`}
                  {(openByMember.get(c.memberId) ?? 0) > 0 && ` · ${openByMember.get(c.memberId)} open listing${openByMember.get(c.memberId) === 1 ? '' : 's'}`}
                </p>
              </div>
              {c.memberId !== selfId && <FollowButton storeId={c.storeId} following={selfFollows.has(c.storeId)} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
