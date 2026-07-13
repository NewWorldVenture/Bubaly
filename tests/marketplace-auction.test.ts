import { describe, it, expect } from 'vitest';
import {
  bidIncrementCents, minNextBidCents, reserveMet, auctionStatus, isLive,
  timeLeft, resolveAuctionOutcome, quickBidLadder, type AuctionListing,
} from '@/lib/marketplace/auction';

const base: AuctionListing = {
  saleFormat: 'auction', status: 'available',
  startingBidCents: 1000, currentBidCents: 0, bidCount: 0,
  reserveCents: null, buyNowCents: null,
  auctionStartsAt: null, auctionEndsAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
};

describe('bidIncrementCents (tiered, must mirror the SQL)', () => {
  it('rises with price', () => {
    expect(bidIncrementCents(50)).toBe(5);
    expect(bidIncrementCents(300)).toBe(25);
    expect(bidIncrementCents(1500)).toBe(50);
    expect(bidIncrementCents(5000)).toBe(100);
    expect(bidIncrementCents(20000)).toBe(250);
    expect(bidIncrementCents(50000)).toBe(500);
    expect(bidIncrementCents(200000)).toBe(1000);
  });
});

describe('minNextBidCents', () => {
  it('first bid must reach the starting bid', () => {
    expect(minNextBidCents({ bidCount: 0, startingBidCents: 1000, currentBidCents: 0 })).toBe(1000);
  });
  it('later bids add one increment to the current price', () => {
    expect(minNextBidCents({ bidCount: 3, startingBidCents: 1000, currentBidCents: 1500 })).toBe(1550);
    expect(minNextBidCents({ bidCount: 5, startingBidCents: 1000, currentBidCents: 12000 })).toBe(12250);
  });
});

describe('reserveMet', () => {
  it('no reserve is always met; with reserve needs bids at/over it', () => {
    expect(reserveMet({ reserveCents: null, currentBidCents: 0, bidCount: 0 })).toBe(true);
    expect(reserveMet({ reserveCents: 5000, currentBidCents: 0, bidCount: 0 })).toBe(false);
    expect(reserveMet({ reserveCents: 5000, currentBidCents: 4900, bidCount: 3 })).toBe(false);
    expect(reserveMet({ reserveCents: 5000, currentBidCents: 5000, bidCount: 4 })).toBe(true);
  });
});

describe('auctionStatus / isLive', () => {
  const now = new Date('2026-07-13T12:00:00Z');
  it('scheduled before start, live in the middle, ending_soon under an hour, ended after', () => {
    expect(auctionStatus({ ...base, auctionStartsAt: '2026-07-13T14:00:00Z', auctionEndsAt: '2026-07-13T18:00:00Z' }, now)).toBe('scheduled');
    expect(auctionStatus({ ...base, auctionEndsAt: '2026-07-13T18:00:00Z' }, now)).toBe('live');
    expect(auctionStatus({ ...base, auctionEndsAt: '2026-07-13T12:30:00Z' }, now)).toBe('ending_soon');
    expect(auctionStatus({ ...base, auctionEndsAt: '2026-07-13T11:00:00Z' }, now)).toBe('ended');
  });
  it('isLive requires available status and an unexpired clock', () => {
    expect(isLive({ ...base, auctionEndsAt: '2026-07-13T18:00:00Z' }, now)).toBe(true);
    expect(isLive({ ...base, status: 'claimed', auctionEndsAt: '2026-07-13T18:00:00Z' }, now)).toBe(false);
    expect(isLive({ ...base, auctionEndsAt: '2026-07-13T11:00:00Z' }, now)).toBe(false);
  });
});

describe('timeLeft', () => {
  const now = new Date('2026-07-13T12:00:00Z');
  it('formats days/hours/minutes/seconds and Ended', () => {
    expect(timeLeft('2026-07-15T16:00:00Z', now)).toBe('2d 4h');
    expect(timeLeft('2026-07-13T15:12:00Z', now)).toBe('3h 12m');
    expect(timeLeft('2026-07-13T12:00:45Z', now)).toBe('45s');
    expect(timeLeft('2026-07-13T11:00:00Z', now)).toBe('Ended');
    expect(timeLeft(null, now)).toBe('Ended');
  });
});

describe('resolveAuctionOutcome', () => {
  it('no bids → not sold', () => {
    const o = resolveAuctionOutcome(base, null);
    expect(o.sold).toBe(false);
    expect(o.reason).toBe('no_bids');
  });
  it('reserve not met → not sold, keeps final price for reporting', () => {
    const a = { ...base, bidCount: 4, currentBidCents: 4000, reserveCents: 5000 };
    const o = resolveAuctionOutcome(a, { memberId: 'm1', familyId: 'f1' });
    expect(o.sold).toBe(false);
    expect(o.reason).toBe('reserve_not_met');
    expect(o.finalPriceCents).toBe(4000);
  });
  it('reserve met (or none) → sold to the leader at the current price', () => {
    const a = { ...base, bidCount: 6, currentBidCents: 7200, reserveCents: 5000 };
    const o = resolveAuctionOutcome(a, { memberId: 'm2', familyId: 'f2' });
    expect(o).toEqual({ sold: true, winnerMemberId: 'm2', winnerFamilyId: 'f2', finalPriceCents: 7200, reason: 'sold' });
  });
});

describe('quickBidLadder', () => {
  it('offers three ascending one-tap amounts starting at the minimum', () => {
    const ladder = quickBidLadder({ bidCount: 2, startingBidCents: 1000, currentBidCents: 1500 });
    expect(ladder[0]).toBe(1550);
    expect(ladder[1]).toBeGreaterThan(ladder[0]);
    expect(ladder[2]).toBeGreaterThan(ladder[1]);
  });
});
