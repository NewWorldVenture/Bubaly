import { describe, it, expect } from 'vitest';
import {
  kindHasPrice, formatCents, priceLabel, dollarsToCents,
  isBrowsable, filterListings, availableCount, canOffer, isOwner, openOffersFor,
  type ListingLike, type OfferLike,
} from '@/lib/marketplace/listings';

const listing = (over: Partial<ListingLike> = {}): ListingLike => ({
  id: 'l1', kind: 'sell', category: 'toys', status: 'available', price_cents: 500,
  title: 'Lego set', member_id: 'm1', claimed_by: null, created_at: '2026-01-01T00:00:00Z',
  ...over,
});

describe('money helpers', () => {
  it('kindHasPrice only for sell/rent', () => {
    expect(kindHasPrice('sell')).toBe(true);
    expect(kindHasPrice('rent')).toBe(true);
    expect(kindHasPrice('borrow')).toBe(false);
    expect(kindHasPrice('free')).toBe(false);
    expect(kindHasPrice('wanted')).toBe(false);
  });
  it('formatCents renders whole vs fractional and clamps junk', () => {
    expect(formatCents(1200)).toBe('$12');
    expect(formatCents(1250)).toBe('$12.50');
    expect(formatCents(-5)).toBe('$0');
    expect(formatCents(null)).toBe('$0');
    expect(formatCents(NaN)).toBe('$0');
  });
  it('priceLabel covers each kind', () => {
    expect(priceLabel('free', 0)).toBe('Free');
    expect(priceLabel('borrow', 999)).toBe('');
    expect(priceLabel('wanted', 999)).toBe('');
    expect(priceLabel('sell', 1500)).toBe('$15');
    expect(priceLabel('rent', 500, 'day')).toBe('$5/day');
    expect(priceLabel('rent', 500, null)).toBe('$5');
  });
  it('dollarsToCents parses messy input', () => {
    expect(dollarsToCents('$12.50')).toBe(1250);
    expect(dollarsToCents('8')).toBe(800);
    expect(dollarsToCents('')).toBe(0);
    expect(dollarsToCents('abc')).toBe(0);
    expect(dollarsToCents('-3')).toBe(300); // strips the minus, treats as 3
  });
});

describe('filterListings', () => {
  const rows: ListingLike[] = [
    listing({ id: 'a', status: 'available', kind: 'sell', category: 'toys', title: 'Red bike', created_at: '2026-01-01' }),
    listing({ id: 'b', status: 'claimed', kind: 'free', category: 'clothing', title: 'Coat', created_at: '2026-01-03' }),
    listing({ id: 'c', status: 'available', kind: 'sell', category: 'toys', title: 'Blue bike', created_at: '2026-01-05' }),
    listing({ id: 'd', status: 'withdrawn', kind: 'sell', category: 'toys', title: 'Gone', created_at: '2026-01-06' }),
    listing({ id: 'e', status: 'pending', kind: 'rent', category: 'tools', title: 'Drill', created_at: '2026-01-02' }),
  ];
  it('hides withdrawn/completed and ranks available>pending>claimed then newest', () => {
    const out = filterListings(rows).map((r) => r.id);
    expect(out).not.toContain('d');
    // available (c newest, then a), then pending (e), then claimed (b)
    expect(out).toEqual(['c', 'a', 'e', 'b']);
  });
  it('filters by kind, category and query', () => {
    expect(filterListings(rows, { kind: 'sell' }).map((r) => r.id)).toEqual(['c', 'a']);
    expect(filterListings(rows, { category: 'tools' }).map((r) => r.id)).toEqual(['e']);
    expect(filterListings(rows, { q: 'bike' }).map((r) => r.id)).toEqual(['c', 'a']);
    expect(filterListings(rows, { q: 'BLUE' }).map((r) => r.id)).toEqual(['c']);
  });
  it('isBrowsable / availableCount', () => {
    expect(isBrowsable('withdrawn')).toBe(false);
    expect(isBrowsable('completed')).toBe(false);
    expect(isBrowsable('available')).toBe(true);
    expect(availableCount(rows)).toBe(2);
  });
});

describe('offer / ownership state machine', () => {
  it('isOwner', () => {
    expect(isOwner(listing({ member_id: 'm1' }), 'm1')).toBe(true);
    expect(isOwner(listing({ member_id: 'm1' }), 'm2')).toBe(false);
    expect(isOwner(listing(), null)).toBe(false);
  });
  it('canOffer respects self, status, and existing open offer', () => {
    const l = listing({ id: 'l1', member_id: 'm1', status: 'available' });
    expect(canOffer(l, 'm2', [])).toBe(true);
    expect(canOffer(l, 'm1', [])).toBe(false);            // own listing
    expect(canOffer(l, null, [])).toBe(false);            // not signed in
    expect(canOffer(listing({ status: 'claimed' }), 'm2', [])).toBe(false); // closed
    const existing: OfferLike[] = [{ id: 'o1', listing_id: 'l1', member_id: 'm2', status: 'open' }];
    expect(canOffer(l, 'm2', existing)).toBe(false);       // already offered
    const declined: OfferLike[] = [{ id: 'o1', listing_id: 'l1', member_id: 'm2', status: 'declined' }];
    expect(canOffer(l, 'm2', declined)).toBe(true);        // prior declined → may re-offer
  });
  it('openOffersFor filters by listing + open status', () => {
    const offers: OfferLike[] = [
      { id: 'o1', listing_id: 'l1', member_id: 'm2', status: 'open' },
      { id: 'o2', listing_id: 'l1', member_id: 'm3', status: 'declined' },
      { id: 'o3', listing_id: 'l2', member_id: 'm2', status: 'open' },
    ];
    expect(openOffersFor('l1', offers).map((o) => o.id)).toEqual(['o1']);
  });
});
