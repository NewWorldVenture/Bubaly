import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Sparkles, ShieldCheck, Star, MapPin, Users, BadgeCheck, Lock, CreditCard,
  ShoppingBag, Clock, Package, HelpCircle, Gift, Repeat, Building2, HandHeart,
  Shirt, Baby, Smartphone, Home as HomeIcon, Dumbbell, Mountain, Car, Wrench,
  ToyBrick, LayoutGrid, ArrowRight, Activity as ActivityIcon,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { SaveButton } from '@/components/marketplace/save-button';
import { FollowButton } from '@/components/marketplace/follow-button';
import { QuickPost } from '@/components/marketplace/quick-post';
import { MarketAssistant } from '@/components/marketplace/market-assistant';
import {
  aiPicks, activityFeed, rankCreators,
  type PickListing, type ActivityOrder, type ActivityReview, type CreatorStore,
} from '@/lib/marketplace/discover';
import { ratingSummary } from '@/lib/marketplace/trust';
import { KIND_LABELS, CATEGORY_LABELS, priceLabel, type ListingKind, type ListingCategory, type RentPeriod } from '@/lib/marketplace/listings';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

const BASE = '/marketplace';

type ListingRow = PickListing & { rent_period: string | null; location: string | null; condition: string | null };

const ACTIONS: { label: string; sub: string; href: string; icon: typeof ShoppingBag; tint: string }[] = [
  { label: 'Sell', sub: 'List for sale', href: `${BASE}/browse?post=1&kind=sell`, icon: ShoppingBag, tint: 'text-amber-500 bg-amber-500/12' },
  { label: 'Rent', sub: 'Rent out', href: `${BASE}/browse?post=1&kind=rent`, icon: Clock, tint: 'text-sky-500 bg-sky-500/12' },
  { label: 'Lend', sub: 'Offer to lend', href: `${BASE}/browse?post=1&kind=borrow`, icon: Package, tint: 'text-emerald-500 bg-emerald-500/12' },
  { label: 'Borrow', sub: 'Request to borrow', href: `${BASE}/browse?kind=borrow`, icon: HandHeart, tint: 'text-violet-500 bg-violet-500/12' },
  { label: 'Request', sub: 'Request an item', href: `${BASE}/browse?post=1&kind=wanted`, icon: HelpCircle, tint: 'text-rose-500 bg-rose-500/12' },
  { label: 'Donate', sub: 'Give for free', href: `${BASE}/browse?post=1&kind=donate`, icon: Gift, tint: 'text-pink-500 bg-pink-500/12' },
  { label: 'Swap', sub: 'Trade items', href: `${BASE}/browse?post=1&kind=swap`, icon: Repeat, tint: 'text-teal-500 bg-teal-500/12' },
  { label: 'Create Store', sub: 'Build your brand', href: `${BASE}/store`, icon: Building2, tint: 'text-brand-text bg-brand/12' },
];

const CATEGORY_ICON: Record<string, typeof Shirt> = {
  clothing: Shirt, baby: Baby, electronics: Smartphone, furniture: HomeIcon,
  sports: Dumbbell, toys: ToyBrick, tools: Wrench, books: LayoutGrid,
  games: LayoutGrid, other: LayoutGrid,
};

const BADGE_STYLE: Record<string, string> = {
  'AI Match': 'bg-brand/15 text-brand-text',
  'Hot Rental': 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  'Great Deal': 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  'Borrow Nearby': 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  'Trending': 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  'New Today': 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
};


export default async function MarketplaceHomePage() {
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const selfId = ctx.active.member.id;
  const now = new Date();

  // ── Load everything best-effort: a not-yet-applied 0151 must never 500 ──────
  const safe = async <T,>(q: PromiseLike<{ data: T[] | null }>): Promise<T[]> => {
    try { return ((await q).data ?? []) as T[]; } catch { return []; }
  };

  const listings = await safe<ListingRow>(
    sb.from('marketplace_listings')
      .select('id, kind, category, status, title, member_id, price_cents, created_at, rent_period, location, condition')
      .eq('family_id', familyId).limit(800),
  );

  const { data: members } = await sb.from('family_members').select('id, display_name').eq('family_id', familyId);
  const nameOf = (id: string | null) => members?.find((m) => m.id === id)?.display_name ?? null;

  const [offers, matches, saves, stores, follows, reviews, orders, collections, collItems] = await Promise.all([
    safe<{ listing_id: string; status: string }>(sb.from('marketplace_offers').select('listing_id, status').eq('family_id', familyId).eq('status', 'open').limit(1000)),
    safe<{ supply_id: string }>(sb.from('marketplace_matches').select('supply_id').eq('family_id', familyId).eq('status', 'active').limit(200)),
    safe<{ listing_id: string; member_id: string }>(sb.from('marketplace_saves').select('listing_id, member_id').eq('family_id', familyId).limit(2000)),
    safe<CreatorStore>(sb.from('marketplace_stores').select('id, member_id, name, emoji, is_active').eq('family_id', familyId)),
    safe<{ store_id: string; member_id: string }>(sb.from('marketplace_follows').select('store_id, member_id').eq('family_id', familyId).limit(2000)),
    safe<{ listing_id: string | null; reviewee_member: string | null; rating: number; created_at: string; id: string }>(
      sb.from('marketplace_reviews').select('id, listing_id, reviewee_member, rating, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(500)),
    safe<ActivityOrder & { seller_member: string | null; amount_cents: number }>(
      sb.from('marketplace_orders').select('id, kind, status, buyer_member, seller_member, listing_id, amount_cents, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(200)),
    safe<{ id: string; name: string; emoji: string | null; description: string | null }>(
      sb.from('marketplace_collections').select('id, name, emoji, description').eq('family_id', familyId).limit(8)),
    safe<{ collection_id: string }>(sb.from('marketplace_collection_items').select('collection_id').eq('family_id', familyId).limit(2000)),
  ]);

  // ── Derived intelligence (all pure engines) ─────────────────────────────────
  const savesByListing = new Map<string, number>();
  const selfSaved = new Set<string>();
  for (const s of saves) {
    savesByListing.set(s.listing_id, (savesByListing.get(s.listing_id) ?? 0) + 1);
    if (s.member_id === selfId) selfSaved.add(s.listing_id);
  }
  const offersByListing = new Map<string, number>();
  for (const o of offers) offersByListing.set(o.listing_id, (offersByListing.get(o.listing_id) ?? 0) + 1);

  const byId = new Map(listings.map((l) => [l.id, l]));
  const picks = aiPicks(listings, {
    matchedIds: new Set(matches.map((m) => m.supply_id)),
    savesByListing, offersByListing,
  }, now, 6).flatMap((p) => {
    const l = byId.get(p.listingId);
    return l ? [{ ...p, listing: l }] : [];
  });

  const ratingsByListing = new Map<string, number[]>();
  const ratingsByMember = new Map<string, number[]>();
  for (const r of reviews) {
    if (r.listing_id) ratingsByListing.set(r.listing_id, [...(ratingsByListing.get(r.listing_id) ?? []), r.rating]);
    if (r.reviewee_member) ratingsByMember.set(r.reviewee_member, [...(ratingsByMember.get(r.reviewee_member) ?? []), r.rating]);
  }

  const followersByStore = new Map<string, number>();
  const selfFollows = new Set<string>();
  for (const f of follows) {
    followersByStore.set(f.store_id, (followersByStore.get(f.store_id) ?? 0) + 1);
    if (f.member_id === selfId) selfFollows.add(f.store_id);
  }
  const creators = rankCreators(stores, ratingsByMember, followersByStore).slice(0, 4);

  const feed = activityFeed(
    orders as ActivityOrder[],
    reviews as ActivityReview[],
    listings.map((l) => ({ id: l.id, title: l.title, member_id: l.member_id, created_at: l.created_at })),
    nameOf, now, 5,
  );

  const itemsByCollection = new Map<string, number>();
  for (const it of collItems) itemsByCollection.set(it.collection_id, (itemsByCollection.get(it.collection_id) ?? 0) + 1);

  // Hero features: the top rated / freshest open supply.
  const hero = [...listings]
    .filter((l) => (l.status === 'available' || l.status === 'pending') && l.kind !== 'wanted')
    .sort((a, b) => (ratingsByListing.get(b.id)?.length ?? 0) - (ratingsByListing.get(a.id)?.length ?? 0) || b.created_at.localeCompare(a.created_at))
    .slice(0, 3);

  const matchCount = matches.length;

  const listingChip = (l: ListingRow) =>
    priceLabel(l.kind as ListingKind, l.price_cents, l.rent_period as RentPeriod | null) || KIND_LABELS[l.kind as ListingKind];

  const ratingChip = (id: string) => {
    const { avg, count } = ratingSummary(ratingsByListing.get(id) ?? []);
    return count > 0 ? `★ ${avg.toFixed(1)} (${count})` : null;
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-5">
        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <section className="overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-surface via-surface to-brand/10 p-5 sm:p-6">
          <div className="flex flex-col gap-5 md:flex-row md:items-center">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold leading-tight sm:text-3xl">
                The world’s easiest<br />
                <span className="text-brand-text">AI-first marketplace</span>
              </h1>
              <p className="mt-2 text-sm text-muted">
                Buy, sell, rent, borrow, lend &amp; more — all in one trusted family community.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {[
                  { icon: Sparkles, label: 'AI-Powered' },
                  { icon: BadgeCheck, label: 'Verified Members' },
                  { icon: Star, label: 'Two-Sided Reviews' },
                  { icon: Lock, label: 'Secure Payments' },
                ].map(({ icon: Icon, label }) => (
                  <span key={label} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface/70 px-2.5 py-1 text-[11px] font-medium text-muted">
                    <Icon className="h-3 w-3 text-brand-text" /> {label}
                  </span>
                ))}
              </div>
            </div>
            {hero.length > 0 && (
              <div className="flex shrink-0 gap-2.5 overflow-x-auto">
                {hero.map((l) => (
                  <Link key={l.id} href={`${BASE}/item/${l.id}`} className="w-36 shrink-0 rounded-xl border border-border bg-surface/80 p-3 transition hover:border-brand/40">
                    <span className="inline-block rounded-md bg-brand/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-text">
                      {KIND_LABELS[l.kind as ListingKind]}
                    </span>
                    <p className="mt-1.5 line-clamp-2 text-xs font-medium">{l.title}</p>
                    <p className="mt-1 text-xs font-semibold text-brand-text">{listingChip(l)}</p>
                    {ratingChip(l.id) && <p className="mt-0.5 text-[10px] text-amber-500">{ratingChip(l.id)}</p>}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ── Post in 60 seconds — the one-sentence AI listing composer ────── */}
        <QuickPost />

        {/* ── What would you like to do? ───────────────────────────────────── */}
        <section className="rounded-2xl border border-border bg-surface/60 p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">What would you like to do?</h2>
            <span className="text-[11px] text-muted">Post in under 60 seconds</span>
          </div>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
            {ACTIONS.map((a) => {
              const Icon = a.icon;
              return (
                <Link key={a.label} href={a.href} className="group flex flex-col items-center gap-1.5 rounded-xl border border-transparent p-2 text-center transition hover:border-border hover:bg-elevated">
                  <span className={cn('grid h-10 w-10 place-items-center rounded-full', a.tint)}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="text-xs font-medium">{a.label}</span>
                  <span className="hidden text-[10px] leading-tight text-muted sm:block">{a.sub}</span>
                </Link>
              );
            })}
          </div>
        </section>

        {/* ── AI Picks for You ─────────────────────────────────────────────── */}
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-brand-text" /> AI Picks for You
              <span className="text-[11px] font-normal text-muted">Personalized</span>
            </h2>
            <Link href={`${BASE}/browse`} className="text-xs text-brand-text hover:underline">View all</Link>
          </div>
          {picks.length === 0 ? (
            <div className="rounded-2xl border border-border bg-surface/40 p-6 text-center text-sm text-muted">
              Nothing on the board yet — <Link href={`${BASE}/browse?post=1`} className="text-brand-text hover:underline">post the first item</Link>.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
              {picks.map(({ listing: l, badge }) => (
                <div key={l.id} className="group relative rounded-xl border border-border bg-surface/60 p-3 transition hover:border-brand/40">
                  <div className="mb-1.5 flex items-start justify-between gap-1">
                    <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-semibold', BADGE_STYLE[badge])}>{badge}</span>
                    <SaveButton listingId={l.id} saved={selfSaved.has(l.id)} />
                  </div>
                  <Link href={`${BASE}/item/${l.id}`}>
                    <p className="line-clamp-2 text-xs font-medium">{l.title}</p>
                    <p className="mt-1 text-sm font-semibold text-brand-text">{listingChip(l)}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted">
                      {ratingChip(l.id) ? <span className="text-amber-500">{ratingChip(l.id)}</span> : <span>{CATEGORY_LABELS[l.category as ListingCategory] ?? l.category}</span>}
                      {l.location && <span className="inline-flex items-center gap-0.5"><MapPin className="h-2.5 w-2.5" />{l.location}</span>}
                    </p>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Assistant / Matches / Safety row ─────────────────────────────── */}
        <section className="grid gap-2.5 sm:grid-cols-3">
          <Link href="/dashboard/assistant" className="group rounded-2xl border border-brand/30 bg-brand/[0.06] p-4 transition hover:bg-brand/10">
            <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> AI Buyer Assistant</p>
            <p className="mt-1 text-xs text-muted">Find exactly what you need in seconds — ask in plain language.</p>
            <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-text">Ask anything <ArrowRight className="h-3 w-3 transition group-hover:translate-x-0.5" /></p>
          </Link>
          <Link href={`${BASE}/browse?kind=wanted`} className="group rounded-2xl border border-border bg-surface/60 p-4 transition hover:border-brand/40">
            <p className="flex items-center gap-2 text-sm font-semibold"><HandHeart className="h-4 w-4 text-brand-text" /> Request &amp; Get Matched</p>
            <p className="mt-1 text-xs text-muted">Can’t find it? Post a request and we’ll match it for you.</p>
            <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {matchCount > 0 ? `${matchCount} match${matchCount === 1 ? '' : 'es'} found!` : 'Post a request'}
            </p>
          </Link>
          <div className="rounded-2xl border border-border bg-surface/60 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-emerald-500" /> Verified. Trusted. Safe.</p>
            <p className="mt-1 text-xs text-muted">All members verified. Two-sided reviews. Exchange with confidence.</p>
            <div className="mt-2 flex gap-1.5">
              {[BadgeCheck, Users, Lock, CreditCard].map((Icon, i) => (
                <span key={i} className="grid h-7 w-7 place-items-center rounded-full bg-elevated"><Icon className="h-3.5 w-3.5 text-muted" /></span>
              ))}
            </div>
          </div>
        </section>

        {/* ── Browse by Category ───────────────────────────────────────────── */}
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Browse by Category</h2>
            <Link href={`${BASE}/browse`} className="text-xs text-brand-text hover:underline">View all</Link>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {(Object.keys(CATEGORY_LABELS) as ListingCategory[]).map((c) => {
              const Icon = CATEGORY_ICON[c] ?? LayoutGrid;
              return (
                <Link key={c} href={`${BASE}/browse?cat=${c}`} className="flex w-20 shrink-0 flex-col items-center gap-1.5 rounded-xl border border-border bg-surface/60 p-3 transition hover:border-brand/40">
                  <Icon className="h-5 w-5 text-brand-text" />
                  <span className="text-[11px] font-medium">{CATEGORY_LABELS[c]}</span>
                </Link>
              );
            })}
          </div>
        </section>

        {/* ── Popular Collections ──────────────────────────────────────────── */}
        {collections.length > 0 && (
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">Popular Collections</h2>
              <Link href={`${BASE}/collections`} className="text-xs text-brand-text hover:underline">View all</Link>
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {collections.slice(0, 4).map((c) => (
                <Link key={c.id} href={`${BASE}/collections?id=${c.id}`} className="rounded-xl border border-border bg-surface/60 p-3.5 transition hover:border-brand/40">
                  <span className="text-lg">{c.emoji ?? '🗂️'}</span>
                  <p className="mt-1 line-clamp-1 text-xs font-semibold">{c.name}</p>
                  <p className="text-[11px] text-muted">{itemsByCollection.get(c.id) ?? 0} items</p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* ── Right rail ───────────────────────────────────────────────────── */}
      <aside className="min-w-0 space-y-4">
        {/* AI Marketplace Assistant — the real in-rail specialist (backlog #11):
            answers from the live board; upgrades to the configured LLM. */}
        <MarketAssistant firstName={ctx.active.member.display_name?.split(' ')[0] ?? 'there'} />

        {/* Nearby Activity */}
        <section className="rounded-2xl border border-border bg-surface/60 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold"><ActivityIcon className="h-4 w-4 text-brand-text" /> Nearby Activity</p>
          <p className="mt-0.5 text-[11px] text-muted">See what’s happening near you</p>
          {feed.length === 0 ? (
            <p className="mt-2 text-xs text-muted">Quiet so far — activity shows here as the family trades.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {feed.map((a) => (
                <li key={a.id} className="text-xs">
                  <p className="text-fg">{a.text}</p>
                  <p className="text-[10px] text-muted">{a.when}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Top Creators */}
        <section className="rounded-2xl border border-border bg-surface/60 p-4">
          <div className="flex items-baseline justify-between">
            <p className="flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4 text-brand-text" /> Top Creators</p>
            <Link href={`${BASE}/creators`} className="text-[11px] text-brand-text hover:underline">View all</Link>
          </div>
          {creators.length === 0 ? (
            <p className="mt-2 text-xs text-muted">
              No storefronts yet — <Link href={`${BASE}/store`} className="text-brand-text hover:underline">open the first one</Link>.
            </p>
          ) : (
            <ul className="mt-2 space-y-2.5">
              {creators.map((c) => (
                <li key={c.storeId} className="flex items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-elevated text-sm">{c.emoji ?? '🛍️'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{c.name}</p>
                    <p className="text-[10px] text-muted">
                      {c.reviewCount > 0 ? `★ ${c.avgRating.toFixed(1)} (${c.reviewCount})` : 'New store'}
                      {c.followerCount > 0 && ` · ${c.followerCount} follower${c.followerCount === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  <FollowButton storeId={c.storeId} following={selfFollows.has(c.storeId)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Safety First */}
        <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.05] p-4">
          <p className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-emerald-500" /> Safety First</p>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            <li>✓ Verified members</li>
            <li>✓ Secure payments</li>
            <li>✓ Two-sided reviews</li>
            <li>✓ Dispute protection</li>
          </ul>
          <Link href="/dashboard/trust" className="mt-2 inline-block text-[11px] text-emerald-600 hover:underline dark:text-emerald-400">
            Learn more about safety
          </Link>
        </section>
      </aside>
    </div>
  );
}
