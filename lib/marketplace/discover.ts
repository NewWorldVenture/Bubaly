// lib/marketplace/discover.ts — marketplace discovery intelligence (pure, tested).
//
// The engines behind the AI-first marketplace home:
//   • aiPicks       — "AI Picks for You": ranked listings, each with the badge
//                     that explains WHY it surfaced (AI Match · Hot Rental ·
//                     Great Deal · Borrow Nearby · Trending · New Today).
//   • activityFeed  — "Nearby Activity": what just happened on the board,
//                     phrased for humans ("Sarah rented a dress · 2 min ago").
//   • rankCreators  — "Top Creators": stores ranked by rating × volume.
// Deterministic + DB-free; the server feeds real rows.

export type PickListing = {
  id: string;
  kind: string;
  category: string;
  status: string;
  title: string;
  member_id: string | null;
  price_cents: number;
  created_at: string;
};

export type PickSignal = {
  /** listing ids with an active wanted↔supply match (0150). */
  matchedIds?: Set<string>;
  /** saves (♥) per listing id. */
  savesByListing?: Map<string, number>;
  /** open offers per listing id. */
  offersByListing?: Map<string, number>;
};

export type PickBadge = 'AI Match' | 'Hot Rental' | 'Great Deal' | 'Borrow Nearby' | 'Trending' | 'New Today';

export type AiPick = {
  listingId: string;
  badge: PickBadge;
  score: number;
};

const OPEN = new Set(['available', 'pending']);
const DAY_MS = 86_400_000;

/**
 * Rank the open supply listings and give each surfaced pick its explaining badge.
 * Scoring: active match 40 · saves ×6 (cap 30) · offers ×5 (cap 20) · new-today 15
 * · below-category-median price 12 · rentals +6. One pick per badge first (variety,
 * like the design), then best-remaining fills to `limit`.
 */
export function aiPicks(listings: PickListing[], signals: PickSignal = {}, now: Date = new Date(), limit = 6): AiPick[] {
  const { matchedIds = new Set<string>(), savesByListing = new Map(), offersByListing = new Map() } = signals;
  const open = listings.filter((l) => OPEN.has(l.status) && l.kind !== 'wanted');
  if (open.length === 0) return [];

  // Category median prices for the "Great Deal" signal (sell listings only).
  const byCat = new Map<string, number[]>();
  for (const l of open) {
    if (l.kind === 'sell' && l.price_cents > 0) {
      const arr = byCat.get(l.category) ?? [];
      arr.push(l.price_cents);
      byCat.set(l.category, arr);
    }
  }
  const medianOf = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const scored = open.map((l) => {
    const saves = savesByListing.get(l.id) ?? 0;
    const offers = offersByListing.get(l.id) ?? 0;
    const isMatch = matchedIds.has(l.id);
    const isNew = now.getTime() - new Date(l.created_at).getTime() < DAY_MS;
    const cat = byCat.get(l.category);
    const isDeal = l.kind === 'sell' && l.price_cents > 0 && !!cat && cat.length >= 3 && l.price_cents < medianOf(cat);

    let score = 0;
    if (isMatch) score += 40;
    score += Math.min(30, saves * 6);
    score += Math.min(20, offers * 5);
    if (isNew) score += 15;
    if (isDeal) score += 12;
    if (l.kind === 'rent') score += 6;

    // The badge = the strongest reason this listing surfaced.
    let badge: PickBadge;
    if (isMatch) badge = 'AI Match';
    else if (l.kind === 'rent' && saves > 0) badge = 'Hot Rental';
    else if (isDeal) badge = 'Great Deal';
    else if (l.kind === 'borrow') badge = 'Borrow Nearby';
    else if (saves + offers >= 3) badge = 'Trending';
    else if (isNew) badge = 'New Today';
    else badge = 'Trending';

    return { listingId: l.id, badge, score };
  }).sort((a, b) => b.score - a.score || a.listingId.localeCompare(b.listingId));

  // Variety pass: first occurrence of each badge, then best remaining.
  const out: AiPick[] = [];
  const seenBadge = new Set<PickBadge>();
  for (const p of scored) {
    if (out.length >= limit) break;
    if (!seenBadge.has(p.badge)) { seenBadge.add(p.badge); out.push(p); }
  }
  for (const p of scored) {
    if (out.length >= limit) break;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

// ── Activity feed ────────────────────────────────────────────────────────────
export type ActivityOrder = { id: string; kind: string; status: string; buyer_member: string | null; listing_id: string; created_at: string };
export type ActivityReview = { id: string; reviewee_member: string | null; created_at: string };
export type ActivityListing = { id: string; title: string; member_id: string | null; created_at: string };

export type ActivityItem = { id: string; text: string; when: string; at: string };

const ORDER_VERB: Record<string, string> = {
  rent: 'rented', buy: 'bought', borrow: 'borrowed', swap: 'swapped for', donate: 'received', free: 'picked up',
};

/** "2 min ago" / "3 hr ago" / "2 days ago" — coarse on purpose. */
export function relativeTime(iso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(iso).getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.floor(hr / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * Fold recent orders, reviews, and fresh listings into one human feed, newest
 * first, capped. Unknown members read as "Someone" so a partial join never hides
 * real activity.
 */
export function activityFeed(
  orders: ActivityOrder[],
  reviews: ActivityReview[],
  listings: ActivityListing[],
  nameOf: (memberId: string | null) => string | null,
  now: Date = new Date(),
  limit = 6,
): ActivityItem[] {
  const titleOf = new Map(listings.map((l) => [l.id, l.title]));
  const who = (id: string | null) => nameOf(id) ?? 'Someone';

  const items: ActivityItem[] = [];
  for (const o of orders) {
    const verb = ORDER_VERB[o.kind] ?? 'claimed';
    const title = titleOf.get(o.listing_id) ?? 'an item';
    items.push({ id: `o-${o.id}`, text: `${who(o.buyer_member)} ${verb} ${title}`, when: relativeTime(o.created_at, now), at: o.created_at });
  }
  for (const r of reviews) {
    items.push({ id: `r-${r.id}`, text: `${who(r.reviewee_member)} received a review`, when: relativeTime(r.created_at, now), at: r.created_at });
  }
  for (const l of listings) {
    if (now.getTime() - new Date(l.created_at).getTime() < 3 * DAY_MS) {
      items.push({ id: `l-${l.id}`, text: `${who(l.member_id)} listed ${l.title}`, when: relativeTime(l.created_at, now), at: l.created_at });
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// ── Top creators ─────────────────────────────────────────────────────────────
export type CreatorStore = { id: string; member_id: string; name: string; emoji: string | null; is_active: boolean };

export type RankedCreator = {
  storeId: string;
  memberId: string;
  name: string;
  emoji: string | null;
  avgRating: number;
  reviewCount: number;
  followerCount: number;
  score: number;
};

/**
 * Rank stores for the "Top Creators" rail: average rating weighted by review
 * volume, plus followers. Inactive stores are excluded.
 */
export function rankCreators(
  stores: CreatorStore[],
  ratingsByMember: Map<string, number[]>,
  followersByStore: Map<string, number>,
): RankedCreator[] {
  return stores
    .filter((s) => s.is_active)
    .map((s) => {
      const ratings = ratingsByMember.get(s.member_id) ?? [];
      const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
      const followers = followersByStore.get(s.id) ?? 0;
      const volumeFactor = Math.min(1, ratings.length / 10);
      const score = avg * 20 * (0.5 + 0.5 * volumeFactor) + Math.min(20, followers * 2);
      return {
        storeId: s.id, memberId: s.member_id, name: s.name, emoji: s.emoji,
        avgRating: Math.round(avg * 10) / 10, reviewCount: ratings.length,
        followerCount: followers, score: Math.round(score),
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
