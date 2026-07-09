import { describe, it, expect } from 'vitest';
import { marketplaceInsights, type InsightListing } from '@/lib/marketplace/insights';

const L = (over: Partial<InsightListing> = {}): InsightListing => ({
  id: 'l', kind: 'sell', category: 'toys', status: 'available', price_cents: 1000, member_id: 'm1', ...over,
});

describe('marketplaceInsights', () => {
  it('counts open supply vs wanted, excluding closed listings', () => {
    const r = marketplaceInsights({ listings: [
      L({ id: 'a' }),
      L({ id: 'b', status: 'completed' }),   // closed → excluded
      L({ id: 'w', kind: 'wanted' }),
    ] });
    expect(r.totalActive).toBe(1); // only 'a'
    expect(r.totalWanted).toBe(1);
  });

  it('groups supply by kind (desc), excluding wanted', () => {
    const r = marketplaceInsights({ listings: [
      L({ id: '1', kind: 'sell' }), L({ id: '2', kind: 'sell' }),
      L({ id: '3', kind: 'rent' }),
      L({ id: '4', kind: 'wanted' }),
    ] });
    expect(r.byKind).toEqual([{ kind: 'sell', count: 2 }, { kind: 'rent', count: 1 }]);
  });

  it('computes supply/demand per category and flags demand gaps', () => {
    const r = marketplaceInsights({ listings: [
      // sports: 1 supply, 3 wanted → under-supplied
      L({ id: 's1', category: 'sports', kind: 'sell' }),
      L({ id: 'w1', category: 'sports', kind: 'wanted' }),
      L({ id: 'w2', category: 'sports', kind: 'wanted' }),
      L({ id: 'w3', category: 'sports', kind: 'wanted' }),
      // toys: 2 supply, 0 wanted
      L({ id: 't1', category: 'toys', kind: 'sell' }),
      L({ id: 't2', category: 'toys', kind: 'rent' }),
    ] });
    const sports = r.categories.find((c) => c.category === 'sports')!;
    expect(sports.activeSupply).toBe(1);
    expect(sports.wanted).toBe(3);
    expect(sports.demandIndex).toBe(3);
    // most under-supplied first
    expect(r.categories[0].category).toBe('sports');
    expect(r.demandGaps.map((c) => c.category)).toEqual(['sports']); // toys has no unmet demand
  });

  it('builds sell-price benchmarks per category (median + avg)', () => {
    const r = marketplaceInsights({ listings: [
      L({ id: '1', category: 'books', kind: 'sell', price_cents: 1000 }),
      L({ id: '2', category: 'books', kind: 'sell', price_cents: 2000 }),
      L({ id: '3', category: 'books', kind: 'sell', price_cents: 3000 }),
      L({ id: '4', category: 'books', kind: 'free', price_cents: 0 }),   // free → ignored
      L({ id: '5', category: 'books', kind: 'sell', price_cents: 0 }),   // no price → ignored
    ] });
    const books = r.prices.find((p) => p.category === 'books')!;
    expect(books.count).toBe(3);
    expect(books.medianCents).toBe(2000);
    expect(books.avgCents).toBe(2000);
  });

  it('ranks hot listings by engagement (saves ×2 + offers ×3), top N', () => {
    const r = marketplaceInsights({
      listings: [L({ id: 'a' }), L({ id: 'b' }), L({ id: 'c' })],
      savesByListing: new Map([['a', 5], ['b', 1]]),
      offersByListing: new Map([['b', 4], ['a', 0]]),
    }, 2);
    // a: 5*2=10 ; b: 1*2 + 4*3 = 14 ; c: 0 (excluded)
    expect(r.hot.map((h) => h.listingId)).toEqual(['b', 'a']);
    expect(r.hot[0].heat).toBe(14);
    expect(r.hot).toHaveLength(2);
  });

  it('is stable on empty input', () => {
    const r = marketplaceInsights({ listings: [] });
    expect(r).toMatchObject({ totalActive: 0, totalWanted: 0, byKind: [], categories: [], prices: [], hot: [], demandGaps: [] });
  });
});
