// Marketplace auctions — pure engine (the eBay-beating core), no I/O.
//
// The atomic bid placement lives in the DB (marketplace_place_bid RPC, which
// row-locks the listing). These pure helpers power the UI and are the single
// source of truth for increment tiers, status, and time formatting — mirrored
// by the SQL so client previews and server truth always agree. Fully tested.

export type AuctionStatus = 'scheduled' | 'live' | 'ending_soon' | 'ended';

export interface AuctionListing {
  saleFormat: string;
  status: string;                 // listing status (available / claimed / …)
  startingBidCents: number;
  currentBidCents: number;
  bidCount: number;
  reserveCents: number | null;
  buyNowCents: number | null;
  auctionStartsAt: string | null;
  auctionEndsAt: string | null;
}

/** Tiered minimum increment by current price — must match the SQL exactly. */
export function bidIncrementCents(currentCents: number): number {
  if (currentCents < 100) return 5;
  if (currentCents < 500) return 25;
  if (currentCents < 2500) return 50;
  if (currentCents < 10000) return 100;
  if (currentCents < 25000) return 250;
  if (currentCents < 100000) return 500;
  return 1000;
}

/** The smallest MAX bid the next bidder may submit. */
export function minNextBidCents(a: Pick<AuctionListing, 'bidCount' | 'startingBidCents' | 'currentBidCents'>): number {
  if (a.bidCount === 0) return Math.max(a.startingBidCents, 1);
  return a.currentBidCents + bidIncrementCents(a.currentBidCents);
}

/** True once the visible price has met/exceeded the (hidden) reserve. */
export function reserveMet(a: Pick<AuctionListing, 'reserveCents' | 'currentBidCents' | 'bidCount'>): boolean {
  if (a.reserveCents == null) return true;         // no reserve → always "met"
  if (a.bidCount === 0) return false;
  return a.currentBidCents >= a.reserveCents;
}

export function isAuction(a: Pick<AuctionListing, 'saleFormat'>): boolean {
  return a.saleFormat === 'auction';
}

export function auctionStatus(a: AuctionListing, now: Date = new Date()): AuctionStatus {
  if (!isAuction(a) || !a.auctionEndsAt) return 'ended';
  const ends = new Date(a.auctionEndsAt).getTime();
  const t = now.getTime();
  if (a.auctionStartsAt) {
    const starts = new Date(a.auctionStartsAt).getTime();
    if (t < starts) return 'scheduled';
  }
  if (t >= ends) return 'ended';
  if (ends - t <= 60 * 60 * 1000) return 'ending_soon';   // ≤ 1h
  return 'live';
}

export function isLive(a: AuctionListing, now: Date = new Date()): boolean {
  const s = auctionStatus(a, now);
  return (s === 'live' || s === 'ending_soon') && a.status === 'available';
}

/** Compact "2d 4h" / "3h 12m" / "45s" countdown, or "Ended". */
export function timeLeft(endsAtIso: string | null, now: Date = new Date()): string {
  if (!endsAtIso) return 'Ended';
  let ms = new Date(endsAtIso).getTime() - now.getTime();
  if (ms <= 0) return 'Ended';
  const d = Math.floor(ms / 86400000); ms -= d * 86400000;
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface BidRow {
  bidderMemberId: string;
  bidderFamilyId: string;
  amountCents: number;
  maxCents: number;
  status: string;
  createdAt: string;
}

export interface AuctionOutcome {
  sold: boolean;
  winnerMemberId: string | null;
  winnerFamilyId: string | null;
  finalPriceCents: number;
  reason: 'sold' | 'reserve_not_met' | 'no_bids';
}

/** Determine the winner when an auction closes (also used to preview outcome). */
export function resolveAuctionOutcome(a: AuctionListing, leader: {
  memberId: string | null; familyId: string | null;
} | null): AuctionOutcome {
  if (a.bidCount === 0 || !leader?.memberId) {
    return { sold: false, winnerMemberId: null, winnerFamilyId: null, finalPriceCents: 0, reason: 'no_bids' };
  }
  if (!reserveMet(a)) {
    return { sold: false, winnerMemberId: null, winnerFamilyId: null, finalPriceCents: a.currentBidCents, reason: 'reserve_not_met' };
  }
  return {
    sold: true,
    winnerMemberId: leader.memberId,
    winnerFamilyId: leader.familyId,
    finalPriceCents: a.currentBidCents,
    reason: 'sold',
  };
}

/** Suggested quick-bid amounts above the minimum (one-tap ladders). */
export function quickBidLadder(a: Pick<AuctionListing, 'bidCount' | 'startingBidCents' | 'currentBidCents'>): number[] {
  const min = minNextBidCents(a);
  const inc = bidIncrementCents(a.currentBidCents || a.startingBidCents);
  return [min, min + inc * 2, min + inc * 5];
}
