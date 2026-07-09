import { describe, it, expect } from 'vitest';
import { buildFollowingFeed, newFromFollowingCount, type FeedListing, type StoreRow } from '@/lib/marketplace/following';

const NOW = new Date('2026-07-10T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const store = (id: string, member: string, over: Partial<StoreRow> = {}): StoreRow => ({ id, member_id: member, name: `${member}'s store`, emoji: '🛍️', is_active: true, ...over });
const L = (id: string, member: string, over: Partial<FeedListing> = {}): FeedListing => ({
  id, member_id: member, title: id, kind: 'sell', price_cents: 1000, status: 'available', created_at: daysAgo(1), ...over,
});

describe('buildFollowingFeed', () => {
  it('returns [] when nothing is followed', () => {
    expect(buildFollowingFeed([], [store('s1', 'm1')], [L('a', 'm1')], { now: NOW })).toEqual([]);
  });

  it('includes browsable listings from followed stores, newest first, with store attribution', () => {
    const feed = buildFollowingFeed(
      [{ store_id: 's1' }],
      [store('s1', 'm1', { name: 'Sarah’s Shop', emoji: '🧸' })],
      [L('old', 'm1', { created_at: daysAgo(20) }), L('new', 'm1', { created_at: daysAgo(1) })],
      { now: NOW },
    );
    expect(feed.map((f) => f.listing.id)).toEqual(['new', 'old']);
    expect(feed[0].storeName).toBe('Sarah’s Shop');
    expect(feed[0].storeEmoji).toBe('🧸');
  });

  it('excludes non-followed stores, inactive stores, and closed listings', () => {
    const feed = buildFollowingFeed(
      [{ store_id: 's1' }],
      [store('s1', 'm1'), store('s2', 'm2'), store('s3', 'm3', { is_active: false })],
      [
        L('followed', 'm1'),
        L('notfollowed', 'm2'),         // store not followed
        L('sold', 'm1', { status: 'completed' }), // closed
      ],
      { now: NOW },
    );
    expect(feed.map((f) => f.listing.id)).toEqual(['followed']);
  });

  it('flags items new within the window and counts them', () => {
    const feed = buildFollowingFeed(
      [{ store_id: 's1' }],
      [store('s1', 'm1')],
      [L('fresh', 'm1', { created_at: daysAgo(2) }), L('stale', 'm1', { created_at: daysAgo(30) })],
      { now: NOW, newWithinDays: 7 },
    );
    expect(feed.find((f) => f.listing.id === 'fresh')!.isNew).toBe(true);
    expect(feed.find((f) => f.listing.id === 'stale')!.isNew).toBe(false);
    expect(newFromFollowingCount(feed)).toBe(1);
  });

  it('respects the limit', () => {
    const listings = Array.from({ length: 10 }, (_, i) => L(`l${i}`, 'm1', { created_at: daysAgo(i) }));
    const feed = buildFollowingFeed([{ store_id: 's1' }], [store('s1', 'm1')], listings, { now: NOW, limit: 3 });
    expect(feed).toHaveLength(3);
    expect(feed[0].listing.id).toBe('l0'); // newest
  });
});
