// lib/marketplace/following.ts — "Following" feed (pure, tested).
// Assembles the recent listings from the stores a member follows into one feed,
// newest first, each annotated with its store + a "new since you followed" flag.
// DB-free; the server feeds live follows / stores / listings.

export type FollowRow = { store_id: string };
export type StoreRow = { id: string; member_id: string; name: string; emoji: string | null; is_active?: boolean };
export type FeedListing = {
  id: string;
  member_id: string | null;
  title: string;
  kind: string;
  price_cents: number;
  rent_period?: string | null;
  status: string;
  created_at: string;
};

export type FeedItem = {
  listing: FeedListing;
  storeName: string;
  storeEmoji: string | null;
  isNew: boolean;
};

const BROWSABLE = new Set(['available', 'pending']);
const DAY_MS = 86_400_000;

/**
 * Build the following feed: browsable listings from the members whose (active)
 * stores the viewer follows, newest first. `newWithinDays` flags fresh items.
 */
export function buildFollowingFeed(
  follows: FollowRow[],
  stores: StoreRow[],
  listings: FeedListing[],
  opts: { now?: Date; newWithinDays?: number; limit?: number } = {},
): FeedItem[] {
  const now = opts.now ?? new Date();
  const newWithinDays = opts.newWithinDays ?? 7;
  const limit = opts.limit ?? 50;

  const followed = new Set(follows.map((f) => f.store_id));
  // member_id → store, for the stores actually followed (and active).
  const storeByMember = new Map<string, StoreRow>();
  for (const s of stores) {
    if (!followed.has(s.id)) continue;
    if (s.is_active === false) continue;
    storeByMember.set(s.member_id, s);
  }
  if (storeByMember.size === 0) return [];

  return listings
    .filter((l) => l.member_id != null && storeByMember.has(l.member_id) && BROWSABLE.has(l.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map((l) => {
      const store = storeByMember.get(l.member_id!)!;
      return {
        listing: l,
        storeName: store.name,
        storeEmoji: store.emoji,
        isNew: now.getTime() - new Date(l.created_at).getTime() < newWithinDays * DAY_MS,
      };
    });
}

/** Count of fresh listings across followed stores (for a nav badge / header). */
export function newFromFollowingCount(feed: FeedItem[]): number {
  return feed.filter((i) => i.isNew).length;
}
