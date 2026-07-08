import { describe, it, expect } from 'vitest';
import {
  matchRequest, scoreMatch, listingModes, distanceMiles,
  type MatchListing, type MatchRequest,
} from '@/lib/marketplace/matching';

const dress = (over: Partial<MatchListing> = {}): MatchListing => ({
  id: 'l-dress', title: 'Black cocktail dress', description: 'Elegant evening wear',
  category: 'clothing', modes: ['rent', 'borrow'], size: 'M', color: 'black', brand: 'Zara',
  condition: 'like_new', priceCents: 3000, status: 'available', visibility: 'public', ...over,
});

const wantDress: MatchRequest = {
  title: 'Need a black cocktail dress', itemType: 'clothing', preferredMode: 'borrow',
  size: 'M', color: 'black', brand: 'Zara', budgetCents: 5000,
};

describe('helpers', () => {
  it('maps legacy kind → modes and prefers rich modes', () => {
    expect(listingModes({ id: 'x', title: 't', kind: 'sell' })).toEqual(['buy']);
    expect(listingModes({ id: 'x', title: 't', kind: 'free' })).toEqual(['donate', 'borrow']);
    expect(listingModes({ id: 'x', title: 't', modes: ['Rent'], kind: 'sell' })).toEqual(['rent']);
  });
  it('computes great-circle distance and returns null when unlocated', () => {
    // NYC → Philadelphia ≈ 80 mi
    expect(distanceMiles(40.71, -74.0, 39.95, -75.16)).toBeGreaterThan(70);
    expect(distanceMiles(40.71, -74.0, 39.95, -75.16)).toBeLessThan(95);
    expect(distanceMiles(1, 1, null, 2)).toBeNull();
  });
});

describe('scoreMatch hard filters', () => {
  it('rejects a listing that does not support the requested mode', () => {
    expect(scoreMatch({ preferredMode: 'buy' }, dress({ modes: ['rent'] }))).toBeNull();
  });
  it('rejects an unavailable or non-public listing', () => {
    expect(scoreMatch(wantDress, dress({ status: 'withdrawn' }))).toBeNull();
    expect(scoreMatch(wantDress, dress({ visibility: 'family' }))).toBeNull();
  });
  it('rejects a paid listing over budget', () => {
    expect(scoreMatch({ preferredMode: 'rent', budgetCents: 2000 }, dress({ modes: ['rent'], priceCents: 9000 }))).toBeNull();
  });
  it('rejects a listing outside the requested radius', () => {
    const far = dress({ latitude: 34.05, longitude: -118.24 }); // LA
    expect(scoreMatch({ ...wantDress, latitude: 40.71, longitude: -74.0, radiusMiles: 50 }, far)).toBeNull();
  });
});

describe('scoreMatch scoring', () => {
  it('a fully-specified exact match scores 100 with rich reasons', () => {
    const r = scoreMatch(wantDress, dress())!;
    expect(r).not.toBeNull();
    expect(r.score).toBe(100);
    expect(r.reasons.join(' ')).toContain('size M');
    expect(r.reasons.join(' ')).toContain('brand Zara');
  });
  it('a partial match scores between 0 and 100', () => {
    const r = scoreMatch(wantDress, dress({ size: 'L', brand: 'H&M' }))!; // size + brand mismatch
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
  });
  it('keeps distance in the result when both sides are located', () => {
    const r = scoreMatch({ ...wantDress, latitude: 40.71, longitude: -74.0 },
      dress({ latitude: 40.73, longitude: -74.01 }))!;
    expect(r.distanceMiles).not.toBeNull();
    expect(r.distanceMiles!).toBeLessThan(5);
  });
});

describe('matchRequest ranking', () => {
  const listings: MatchListing[] = [
    dress({ id: 'exact' }),
    dress({ id: 'wrong-size', size: 'XXL', color: 'red', brand: 'H&M' }),
    dress({ id: 'unavailable', status: 'withdrawn' }),
    dress({ id: 'wrong-mode', modes: ['buy'] }),
    { id: 'unrelated', title: 'Camping tent', category: 'sports', modes: ['borrow'], status: 'available', visibility: 'public' },
  ];

  it('ranks the exact match first and drops disqualified listings', () => {
    const results = matchRequest(wantDress, listings);
    expect(results[0].listing.id).toBe('exact');
    const ids = results.map((r) => r.listing.id);
    expect(ids).not.toContain('unavailable'); // withdrawn
    expect(ids).not.toContain('wrong-mode');  // buy-only vs borrow request
  });

  it('respects the result limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => dress({ id: `d-${i}` }));
    expect(matchRequest(wantDress, many, { limit: 5 })).toHaveLength(5);
  });
});
