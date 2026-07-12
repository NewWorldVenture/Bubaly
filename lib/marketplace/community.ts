// lib/marketplace/community.ts — Community Marketplace circles (pure, tested).
//
// Backlog #21 v1: families form opt-in CIRCLES via an invite code and share
// individual listings into them; circle members see exactly what was shared,
// nothing more (see migration 0173 for the RLS model). This module is the
// DOM/DB-free logic: join-code hygiene, feed assembly + attribution, what a
// family is allowed to share, and roster/feed stats for the page header.

export interface CircleLite {
  id: string;
  name: string;
  emoji: string;
  join_code: string;
}

export interface CircleMemberLite {
  circle_id: string;
  family_id: string;
  family_name: string;
  role: string;
}

export interface ShareLite {
  listing_id: string;
  circle_id: string;
  family_id: string;
  created_at: string;
}

export interface SharedListingLite {
  id: string;
  title: string;
  kind: string;
  category: string;
  condition: string | null;
  price_cents: number | null;
  rent_period?: string | null;
  status: string;
  family_id: string;
}

export interface FeedEntry {
  listing: SharedListingLite;
  circleId: string;
  fromFamily: string;
  isMine: boolean;
  sharedAt: string;
}

/** Normalize user-typed join codes: trim, uppercase, drop separators. */
export function normalizeJoinCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/** Display form: "ABCD-EFGH". */
export function formatJoinCode(code: string): string {
  const c = normalizeJoinCode(code);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** A plausible complete code (8 chars after normalizing)? */
export function isValidJoinCode(input: string): boolean {
  return normalizeJoinCode(input).length === 8;
}

/**
 * Which of my listings can be shared into a circle right now: my own,
 * still available, and not already shared into THAT circle.
 */
export function shareableListings<L extends { id: string; family_id: string; status: string }>(
  listings: L[],
  myFamilyId: string,
  circleId: string,
  shares: ShareLite[],
): L[] {
  const sharedHere = new Set(shares.filter((s) => s.circle_id === circleId).map((s) => s.listing_id));
  return listings.filter(
    (l) => l.family_id === myFamilyId && l.status === 'available' && !sharedHere.has(l.id),
  );
}

/**
 * Assemble a circle's feed: shared listings that are still visible-worthy
 * (available or pending), attributed to the sharing family via the circle
 * roster (never the families table), newest share first.
 */
export function buildCircleFeed(
  circleId: string,
  shares: ShareLite[],
  listings: SharedListingLite[],
  members: CircleMemberLite[],
  myFamilyId: string,
): FeedEntry[] {
  const byId = new Map(listings.map((l) => [l.id, l]));
  const nameByFamily = new Map(
    members.filter((m) => m.circle_id === circleId).map((m) => [m.family_id, m.family_name]),
  );
  return shares
    .filter((s) => s.circle_id === circleId)
    .map((s) => {
      const listing = byId.get(s.listing_id);
      if (!listing) return null;
      if (listing.status !== 'available' && listing.status !== 'pending') return null;
      return {
        listing,
        circleId,
        fromFamily: nameByFamily.get(s.family_id) ?? 'A family',
        isMine: s.family_id === myFamilyId,
        sharedAt: s.created_at,
      } satisfies FeedEntry;
    })
    .filter((e): e is FeedEntry => e !== null)
    .sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
}

export interface CircleStats {
  families: number;
  shared: number;
  fromOthers: number;
}

/** Header numbers for one circle. */
export function circleStats(
  circleId: string,
  members: CircleMemberLite[],
  feed: FeedEntry[],
): CircleStats {
  const families = members.filter((m) => m.circle_id === circleId).length;
  const inCircle = feed.filter((f) => f.circleId === circleId);
  return {
    families,
    shared: inCircle.length,
    fromOthers: inCircle.filter((f) => !f.isMine).length,
  };
}
