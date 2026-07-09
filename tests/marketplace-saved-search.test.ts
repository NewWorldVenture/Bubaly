import { describe, it, expect } from 'vitest';
import {
  listingMatchesSearch, matchesForSearch, countNewSince, describeSearch, searchTerms,
  type MatchableListing,
} from '@/lib/marketplace/saved-search';

const L = (over: Partial<MatchableListing> = {}): MatchableListing => ({
  id: 'l1', title: 'Kids balance bike', description: 'Red, barely used', kind: 'sell',
  category: 'sports', price_cents: 3000, status: 'available', created_at: '2026-07-01T00:00:00Z',
  member_id: 'm2', ...over,
});

describe('searchTerms', () => {
  it('lowercases and splits, dropping blanks', () => {
    expect(searchTerms('  Red  Bike ')).toEqual(['red', 'bike']);
    expect(searchTerms(null)).toEqual([]);
  });
});

describe('listingMatchesSearch', () => {
  it('empty criteria match any browsable listing', () => {
    expect(listingMatchesSearch(L(), {})).toBe(true);
  });

  it('excludes non-browsable listings', () => {
    expect(listingMatchesSearch(L({ status: 'completed' }), {})).toBe(false);
    expect(listingMatchesSearch(L({ status: 'withdrawn' }), {})).toBe(false);
  });

  it('requires EVERY query term across title + description (case-insensitive)', () => {
    expect(listingMatchesSearch(L(), { query: 'bike red' })).toBe(true);   // both present
    expect(listingMatchesSearch(L(), { query: 'BIKE' })).toBe(true);
    expect(listingMatchesSearch(L(), { query: 'bike blue' })).toBe(false); // blue absent
  });

  it('filters by kind and category when set', () => {
    expect(listingMatchesSearch(L(), { kind: 'sell' })).toBe(true);
    expect(listingMatchesSearch(L(), { kind: 'rent' })).toBe(false);
    expect(listingMatchesSearch(L(), { category: 'sports' })).toBe(true);
    expect(listingMatchesSearch(L(), { category: 'toys' })).toBe(false);
  });

  it('applies the price ceiling to priced kinds only', () => {
    expect(listingMatchesSearch(L({ price_cents: 3000 }), { maxPriceCents: 5000 })).toBe(true);
    expect(listingMatchesSearch(L({ price_cents: 8000 }), { maxPriceCents: 5000 })).toBe(false);
    // free/borrow have no price → ceiling never rejects them
    expect(listingMatchesSearch(L({ kind: 'free', price_cents: 0 }), { maxPriceCents: 100 })).toBe(true);
    expect(listingMatchesSearch(L({ kind: 'borrow', price_cents: 0 }), { maxPriceCents: 100 })).toBe(true);
  });

  it('excludes the viewer’s own listings', () => {
    expect(listingMatchesSearch(L({ member_id: 'me' }), {}, 'me')).toBe(false);
    expect(listingMatchesSearch(L({ member_id: 'm2' }), {}, 'me')).toBe(true);
  });

  it('combines all criteria (AND)', () => {
    const c = { query: 'bike', kind: 'sell', category: 'sports', maxPriceCents: 5000 };
    expect(listingMatchesSearch(L(), c)).toBe(true);
    expect(listingMatchesSearch(L({ price_cents: 9000 }), c)).toBe(false);
  });
});

describe('matchesForSearch', () => {
  it('returns matches newest-first', () => {
    const rows = [
      L({ id: 'old', created_at: '2026-06-01T00:00:00Z' }),
      L({ id: 'new', created_at: '2026-07-05T00:00:00Z' }),
      L({ id: 'other', category: 'toys' }), // filtered out by category
    ];
    const out = matchesForSearch(rows, { category: 'sports' });
    expect(out.map((l) => l.id)).toEqual(['new', 'old']);
  });
});

describe('countNewSince', () => {
  it('counts only matches created strictly after the cursor', () => {
    const rows = [
      L({ id: 'a', created_at: '2026-07-02T00:00:00Z' }),
      L({ id: 'b', created_at: '2026-07-10T00:00:00Z' }),
      L({ id: 'c', created_at: '2026-06-01T00:00:00Z' }),
    ];
    expect(countNewSince(rows, {}, '2026-07-05T00:00:00Z')).toBe(1); // only b
    expect(countNewSince(rows, {}, '2026-01-01T00:00:00Z')).toBe(3);
  });
});

describe('describeSearch', () => {
  it('summarises the criteria', () => {
    expect(describeSearch({ query: 'bike', kind: 'rent', category: 'sports', maxPriceCents: 5000 },
      { rent: 'For rent' }, { sports: 'Sports' }))
      .toBe('“bike” · For rent · Sports · under $50');
  });
  it('falls back to "Anything new" when empty', () => {
    expect(describeSearch({})).toBe('Anything new');
  });
});
