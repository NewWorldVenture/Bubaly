import { describe, it, expect } from 'vitest';
import {
  aiPicks, relativeTime, activityFeed, rankCreators,
  type PickListing, type ActivityOrder, type ActivityReview, type ActivityListing, type CreatorStore,
} from '@/lib/marketplace/discover';

const NOW = new Date('2026-07-10T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const listing = (id: string, over: Partial<PickListing> = {}): PickListing => ({
  id, kind: 'sell', category: 'toys', status: 'available', title: id, member_id: 'm1',
  price_cents: 1000, created_at: daysAgo(30), ...over,
});

describe('aiPicks', () => {
  it('returns [] when there is no open supply', () => {
    expect(aiPicks([])).toEqual([]);
    expect(aiPicks([listing('a', { status: 'completed' }), listing('b', { kind: 'wanted' })])).toEqual([]);
  });

  it('badges + scores an active AI match highest', () => {
    const picks = aiPicks(
      [listing('a'), listing('b')],
      { matchedIds: new Set(['a']) },
      NOW,
    );
    const a = picks.find((p) => p.listingId === 'a')!;
    expect(a.badge).toBe('AI Match');
    expect(a.score).toBeGreaterThanOrEqual(40);
    expect(picks[0].listingId).toBe('a'); // highest score first
  });

  it('scores saves and offers with caps', () => {
    const picks = aiPicks(
      [listing('a')],
      { savesByListing: new Map([['a', 100]]), offersByListing: new Map([['a', 100]]) },
      NOW,
    );
    // saves cap 30 + offers cap 20 = 50 (no match/new/deal since 30 days old)
    expect(picks[0].score).toBe(50);
    expect(picks[0].badge).toBe('Trending'); // saves+offers >= 3
  });

  it('flags a New Today listing', () => {
    const picks = aiPicks([listing('a', { created_at: hoursAgo(6) })], {}, NOW);
    expect(picks[0].badge).toBe('New Today');
    expect(picks[0].score).toBe(15);
  });

  it('detects a Great Deal below the category median (≥3 sell in category)', () => {
    const picks = aiPicks([
      listing('cheap', { category: 'books', price_cents: 1000, created_at: daysAgo(30) }),
      listing('mid', { category: 'books', price_cents: 2000, created_at: daysAgo(30) }),
      listing('exp', { category: 'books', price_cents: 3000, created_at: daysAgo(30) }),
    ], {}, NOW);
    const cheap = picks.find((p) => p.listingId === 'cheap')!;
    expect(cheap.badge).toBe('Great Deal'); // 1000 < median 2000
    expect(picks.find((p) => p.listingId === 'mid')!.badge).not.toBe('Great Deal');
  });

  it('badges a Hot Rental (rent + saves) and Borrow Nearby', () => {
    const picks = aiPicks([
      listing('r', { kind: 'rent', created_at: daysAgo(30) }),
      listing('b', { kind: 'borrow', created_at: daysAgo(30) }),
    ], { savesByListing: new Map([['r', 1]]) }, NOW);
    expect(picks.find((p) => p.listingId === 'r')!.badge).toBe('Hot Rental');
    expect(picks.find((p) => p.listingId === 'b')!.badge).toBe('Borrow Nearby');
  });

  it('surfaces badge variety before best-remaining, and respects the limit', () => {
    // 3 high-score Trending + 1 low-score New Today; limit 2 should still surface the New Today.
    const picks = aiPicks([
      listing('t1', { savesByListing: undefined, created_at: daysAgo(30) }),
      listing('t2', { created_at: daysAgo(30) }),
      listing('t3', { created_at: daysAgo(30) }),
      listing('n1', { created_at: hoursAgo(1) }),
    ], {
      savesByListing: new Map([['t1', 5], ['t2', 5], ['t3', 5]]),
      offersByListing: new Map([['t1', 5], ['t2', 5], ['t3', 5]]),
    }, NOW, 2);
    expect(picks).toHaveLength(2);
    const badges = picks.map((p) => p.badge);
    expect(badges).toContain('Trending');
    expect(badges).toContain('New Today'); // variety pass surfaced it over t2/t3
  });

  it('is deterministic on score ties (by listingId)', () => {
    const picks = aiPicks([listing('b', { created_at: daysAgo(30) }), listing('a', { created_at: daysAgo(30) })], {}, NOW);
    expect(picks.map((p) => p.listingId)).toEqual(['a', 'b']);
  });
});

describe('relativeTime', () => {
  it('buckets into just now / min / hr / days', () => {
    expect(relativeTime(hoursAgo(0), NOW)).toBe('just now');
    expect(relativeTime(new Date(NOW.getTime() - 30_000).toISOString(), NOW)).toBe('just now');
    expect(relativeTime(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago');
    expect(relativeTime(hoursAgo(3), NOW)).toBe('3 hr ago');
    expect(relativeTime(daysAgo(1), NOW)).toBe('1 day ago');
    expect(relativeTime(daysAgo(4), NOW)).toBe('4 days ago');
  });
  it('clamps future times to "just now"', () => {
    expect(relativeTime(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe('just now');
  });
});

describe('activityFeed', () => {
  const nameOf = (id: string | null) => (id === 'm1' ? 'Sarah' : id === 'm2' ? 'Dad' : null);
  const orders: ActivityOrder[] = [
    { id: 'o1', kind: 'rent', status: 'active', buyer_member: 'm1', listing_id: 'L1', created_at: hoursAgo(1) },
    { id: 'o2', kind: 'buy', status: 'active', buyer_member: 'zzz', listing_id: 'L9', created_at: hoursAgo(2) },
  ];
  const reviews: ActivityReview[] = [{ id: 'rv1', reviewee_member: 'm2', created_at: hoursAgo(3) }];
  const listings: ActivityListing[] = [
    { id: 'L1', title: 'Party Dress', member_id: 'm1', created_at: hoursAgo(1) },
    { id: 'L2', title: 'Old Bike', member_id: 'm2', created_at: daysAgo(10) }, // too old to list-notify
  ];

  it('folds orders/reviews/fresh-listings, newest first, capped', () => {
    const feed = activityFeed(orders, reviews, listings, nameOf, NOW, 6);
    expect(feed[0].text).toMatch(/Sarah rented Party Dress/);
    expect(feed.find((i) => i.id === 'o-o2')!.text).toMatch(/Someone bought an item/); // unknown member + missing title
    expect(feed.some((i) => i.id === 'l-L1')).toBe(true);   // fresh listing surfaces
    expect(feed.some((i) => i.id === 'l-L2')).toBe(false);  // 10-day-old listing does not
    // newest first
    expect(feed[0].at >= feed[feed.length - 1].at).toBe(true);
  });

  it('respects the limit', () => {
    expect(activityFeed(orders, reviews, listings, nameOf, NOW, 1)).toHaveLength(1);
  });
});

describe('rankCreators', () => {
  const stores: CreatorStore[] = [
    { id: 's1', member_id: 'm1', name: 'Sarah Store', emoji: '🧸', is_active: true },
    { id: 's2', member_id: 'm2', name: 'Dad Deals', emoji: null, is_active: true },
    { id: 's3', member_id: 'm3', name: 'Closed', emoji: null, is_active: false },
  ];

  it('excludes inactive stores', () => {
    const ranked = rankCreators(stores, new Map(), new Map());
    expect(ranked.some((c) => c.storeId === 's3')).toBe(false);
  });

  it('ranks by rating × volume + followers, and computes avg/count', () => {
    const ranked = rankCreators(
      stores,
      new Map([['m1', [5, 5, 5, 5, 5]], ['m2', [5]]]),
      new Map([['s1', 3]]),
    );
    const s1 = ranked.find((c) => c.storeId === 's1')!;
    expect(s1.avgRating).toBe(5);
    expect(s1.reviewCount).toBe(5);
    expect(s1.followerCount).toBe(3);
    // 5*20*(0.5+0.5*0.5) + min(20, 6) = 75 + 6 = 81
    expect(s1.score).toBe(81);
    // s1 (well-reviewed + followers) outranks s2 (single review, no followers)
    expect(ranked[0].storeId).toBe('s1');
  });

  it('handles no ratings (score 0, avg 0)', () => {
    const ranked = rankCreators([stores[1]], new Map(), new Map());
    expect(ranked[0].avgRating).toBe(0);
    expect(ranked[0].score).toBe(0);
  });
});
