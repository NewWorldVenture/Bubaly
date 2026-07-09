import { describe, it, expect } from 'vitest';
import { computeTrustScore, ratingSummary } from '@/lib/marketplace/trust';
import {
  aiPicks, activityFeed, rankCreators, relativeTime,
  type PickListing, type ActivityOrder, type CreatorStore,
} from '@/lib/marketplace/discover';

const NOW = new Date('2026-07-09T12:00:00.000Z');

describe('computeTrustScore', () => {
  it('starts a brand-new member at 50 / building', () => {
    const t = computeTrustScore({ ratingsReceived: [], ordersCompleted: 0, listingsPosted: 0 });
    expect(t.score).toBe(50);
    expect(t.band).toBe('building');
    expect(t.factors[0]).toContain('New to the marketplace');
  });

  it('a strong history reaches exceptional', () => {
    const t = computeTrustScore({ ratingsReceived: Array(12).fill(5), ordersCompleted: 25, listingsPosted: 12 });
    expect(t.score).toBeGreaterThanOrEqual(90);
    expect(t.band).toBe('exceptional');
    expect(t.stars).toBeGreaterThanOrEqual(4.5);
  });

  it('one 5★ review is NOT a perfect rating component (volume-scaled)', () => {
    const one = computeTrustScore({ ratingsReceived: [5], ordersCompleted: 0, listingsPosted: 0 });
    const many = computeTrustScore({ ratingsReceived: Array(10).fill(5), ordersCompleted: 0, listingsPosted: 0 });
    expect(one.score).toBeLessThan(many.score);
  });

  it('disputes subtract and surface as a factor', () => {
    const base = computeTrustScore({ ratingsReceived: [5, 5], ordersCompleted: 5, listingsPosted: 5 });
    const disputed = computeTrustScore({ ratingsReceived: [5, 5], ordersCompleted: 5, listingsPosted: 5, disputes: 2 });
    expect(disputed.score).toBe(Math.max(0, base.score - 20));
    expect(disputed.factors.some((f) => f.includes('dispute'))).toBe(true);
  });

  it('ratingSummary averages to one decimal', () => {
    expect(ratingSummary([5, 4, 5])).toEqual({ avg: 4.7, count: 3 });
    expect(ratingSummary([])).toEqual({ avg: 0, count: 0 });
  });
});

const P = (o: Partial<PickListing> & { id: string }): PickListing => ({
  kind: 'sell', category: 'toys', status: 'available', title: o.id,
  member_id: null, price_cents: 1000, created_at: '2026-07-01T00:00:00.000Z', ...o,
});

describe('aiPicks', () => {
  it('badges an active match as "AI Match" and ranks it first', () => {
    const picks = aiPicks(
      [P({ id: 'a' }), P({ id: 'b' })],
      { matchedIds: new Set(['b']) },
      NOW,
    );
    expect(picks[0]).toMatchObject({ listingId: 'b', badge: 'AI Match' });
  });

  it('excludes wanted + closed listings', () => {
    const picks = aiPicks([
      P({ id: 'w', kind: 'wanted' }),
      P({ id: 'x', status: 'completed' }),
      P({ id: 'ok' }),
    ], {}, NOW);
    expect(picks.map((p) => p.listingId)).toEqual(['ok']);
  });

  it('badges a saved rental "Hot Rental" and a fresh listing "New Today"', () => {
    const picks = aiPicks([
      P({ id: 'r', kind: 'rent', price_cents: 2000 }),
      P({ id: 'n', created_at: NOW.toISOString() }),
    ], { savesByListing: new Map([['r', 4]]) }, NOW);
    const by = Object.fromEntries(picks.map((p) => [p.listingId, p.badge]));
    expect(by.r).toBe('Hot Rental');
    expect(by.n).toBe('New Today');
  });

  it('badges a below-median sell price "Great Deal"', () => {
    const picks = aiPicks([
      P({ id: 'cheap', price_cents: 500 }),
      P({ id: 'mid', price_cents: 1000 }),
      P({ id: 'high', price_cents: 2000 }),
    ], {}, NOW);
    expect(picks.find((p) => p.listingId === 'cheap')!.badge).toBe('Great Deal');
  });

  it('varies badges before filling by score', () => {
    const picks = aiPicks([
      P({ id: 'm1' }), P({ id: 'm2' }),
      P({ id: 'b1', kind: 'borrow' }),
    ], { matchedIds: new Set(['m1', 'm2']) }, NOW, 3);
    // first two badges differ even though m2 outscores b1
    expect(picks[0].badge).toBe('AI Match');
    expect(picks.some((p) => p.badge === 'Borrow Nearby')).toBe(true);
  });
});

describe('activityFeed + relativeTime', () => {
  it('formats coarse relative times', () => {
    expect(relativeTime('2026-07-09T11:58:00.000Z', NOW)).toBe('2 min ago');
    expect(relativeTime('2026-07-09T09:00:00.000Z', NOW)).toBe('3 hr ago');
    expect(relativeTime('2026-07-07T09:00:00.000Z', NOW)).toBe('2 days ago');
  });

  it('folds orders, reviews and fresh listings into one newest-first feed', () => {
    const orders: ActivityOrder[] = [
      { id: 'o1', kind: 'rent', status: 'active', buyer_member: 'sarah', listing_id: 'l1', created_at: '2026-07-09T11:58:00.000Z' },
    ];
    const feed = activityFeed(
      orders,
      [{ id: 'rv1', reviewee_member: 'chris', created_at: '2026-07-09T11:00:00.000Z' }],
      [{ id: 'l1', title: 'a dress', member_id: 'emma', created_at: '2026-07-09T11:30:00.000Z' }],
      (id) => (id === 'sarah' ? 'Sarah' : id === 'chris' ? 'Chris' : id === 'emma' ? 'Emma' : null),
      NOW,
    );
    expect(feed[0].text).toBe('Sarah rented a dress');
    expect(feed[1].text).toBe('Emma listed a dress');
    expect(feed[2].text).toBe('Chris received a review');
    expect(feed[0].when).toBe('2 min ago');
  });

  it('reads "Someone" when the member is unknown', () => {
    const feed = activityFeed(
      [{ id: 'o1', kind: 'buy', status: 'completed', buyer_member: null, listing_id: 'x', created_at: NOW.toISOString() }],
      [], [], () => null, NOW,
    );
    expect(feed[0].text).toBe('Someone bought an item');
  });
});

describe('rankCreators', () => {
  const stores: CreatorStore[] = [
    { id: 's1', member_id: 'anna', name: 'Style by Anna', emoji: null, is_active: true },
    { id: 's2', member_id: 'hub', name: 'Outdoor Hub', emoji: null, is_active: true },
    { id: 's3', member_id: 'off', name: 'Closed Shop', emoji: null, is_active: false },
  ];

  it('ranks by rating volume + followers and excludes inactive stores', () => {
    const ranked = rankCreators(
      stores,
      new Map([['anna', Array(10).fill(5)], ['hub', [4]]]),
      new Map([['s1', 12], ['s2', 2]]),
    );
    expect(ranked.map((r) => r.storeId)).toEqual(['s1', 's2']);
    expect(ranked[0]).toMatchObject({ avgRating: 5, reviewCount: 10, followerCount: 12 });
  });
});
