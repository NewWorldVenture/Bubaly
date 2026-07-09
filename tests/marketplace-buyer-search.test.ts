import { describe, it, expect } from 'vitest';
import { parseBudgetCents, parseBuyerMode, parseBuyerQuery, searchListings } from '@/lib/marketplace/buyer-search';
import type { MatchListing } from '@/lib/marketplace/matching';

describe('parseBudgetCents', () => {
  it('reads an explicit ceiling', () => {
    expect(parseBudgetCents('a dress under $50')).toBe(5000);
    expect(parseBudgetCents('less than 40 dollars')).toBe(4000);
    expect(parseBudgetCents('up to $12.50')).toBe(1250);
  });
  it('falls back to a bare dollar amount, or undefined', () => {
    expect(parseBudgetCents('around $25')).toBe(2500);
    expect(parseBudgetCents('a red bike')).toBeUndefined();
  });
});

describe('parseBuyerMode', () => {
  it('detects the acquisition intent', () => {
    expect(parseBuyerMode('a dress to rent near me')).toBe('rent');
    expect(parseBuyerMode('stroller to borrow this weekend')).toBe('borrow');
    expect(parseBuyerMode('camera to buy')).toBe('buy');
    expect(parseBuyerMode('a blue jacket')).toBe('any');
  });
});

describe('parseBuyerQuery', () => {
  it('assembles a MatchRequest from a natural-language query', () => {
    const q = parseBuyerQuery('find me a blue Nike jacket size medium to rent under $60');
    expect(q.preferredMode).toBe('rent');
    expect(q.color).toBe('blue');
    expect(q.brand).toBe('nike');
    expect(q.itemType).toBe('clothing');
    expect(q.budgetCents).toBe(6000);
    expect(q.size).toContain('medium');
  });
});

describe('searchListings (buyer assistant end to end)', () => {
  const listings: MatchListing[] = [
    { id: 'blue-rent', title: 'Blue Nike jacket', category: 'clothing', modes: ['rent'], color: 'blue', brand: 'Nike', size: 'medium', priceCents: 3000, status: 'available', visibility: 'public' },
    { id: 'blue-buy-only', title: 'Blue Nike jacket', category: 'clothing', modes: ['buy'], color: 'blue', brand: 'Nike', size: 'medium', priceCents: 3000, status: 'available', visibility: 'public' },
    { id: 'over-budget', title: 'Blue Nike jacket', category: 'clothing', modes: ['rent'], color: 'blue', brand: 'Nike', priceCents: 20000, status: 'available', visibility: 'public' },
    { id: 'unrelated', title: 'Camping tent', category: 'sports', modes: ['rent'], status: 'available', visibility: 'public' },
  ];

  it('ranks the best rentable, in-budget match first and drops disqualified', () => {
    const results = searchListings('blue Nike jacket size medium to rent under $60', listings);
    expect(results[0].listing.id).toBe('blue-rent');
    const ids = results.map((r) => r.listing.id);
    expect(ids).not.toContain('blue-buy-only'); // rent intent
    expect(ids).not.toContain('over-budget');   // above $60
    expect(results[0].reasons.length).toBeGreaterThan(0); // has reasoning
  });

  it('returns nothing when the query cannot be satisfied', () => {
    expect(searchListings('a purple kayak to buy under $5', listings)).toEqual([]);
  });
});
