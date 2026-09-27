import { describe, it, expect } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import {
  kindHasPrice, formatCents, priceLabel, dollarsToCents, currencyUnit,
  isBrowsable, filterListings, availableCount, canOffer, isOwner, openOffersFor,
  type ListingLike, type OfferLike,
} from '@/lib/marketplace/listings';

// The REAL en-US catalogue, so a sentence missing from it fails here instead of
// reaching a family as its key. The listings.* sentences are added by the I18N-003
// marketplace change and land in lib/i18n/messages/*.json with the orchestrator's
// catalogue merge: until that merge, the cases that render them are red.
const t = (key: string, params?: Record<string, string | number>) =>
  translate(getMessages('en-US'), key, params);

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
    expect(formatCents(1200, 'en-US')).toBe('$12');
    expect(formatCents(1250, 'en-US')).toBe('$12.50');
    expect(formatCents(-5, 'en-US')).toBe('$0');
    expect(formatCents(null, 'en-US')).toBe('$0');
    expect(formatCents(NaN, 'en-US')).toBe('$0');
  });
  it('priceLabel covers each kind', () => {
    expect(priceLabel('free', 0, null, 'en-US', t)).toBe('Free');
    expect(priceLabel('borrow', 999, null, 'en-US', t)).toBe('');
    expect(priceLabel('wanted', 999, null, 'en-US', t)).toBe('');
    expect(priceLabel('sell', 1500, null, 'en-US', t)).toBe('$15');
    expect(priceLabel('rent', 500, 'day', 'en-US', t)).toBe('$5/day');
    expect(priceLabel('rent', 500, null, 'en-US', t)).toBe('$5');
  });
  it('currencyUnit puts a money input’s unit where the reader writes it', () => {
    // The bid/offer/price boxes read this instead of a literal "$" on the left.
    expect(currencyUnit('en-US')).toEqual({ symbol: '$', before: true });
    expect(currencyUnit('de-DE')).toEqual({ symbol: '$', before: false });
    expect(currencyUnit('fr-FR')).toEqual({ symbol: '$US', before: false });
    // …and it agrees with the amounts printed around the box.
    for (const code of ['en-US', 'de-DE', 'fr-FR'] as const) {
      const { symbol, before } = currencyUnit(code);
      const printed = formatCents(2500, code);
      expect(before ? printed.startsWith(symbol) : printed.endsWith(symbol)).toBe(true);
    }
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
