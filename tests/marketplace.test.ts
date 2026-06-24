import { describe, expect, it } from 'vitest';
import {
  listingTypeMeta,
  conditionLabel,
  activeListings,
  listingsByCategory,
  listingsByType,
  marketplaceSummary,
  fmtPrice,
  fmtDate,
  type ListingLike,
} from '@/lib/marketplace/listings';

function listing(overrides: Partial<ListingLike> & { id: string }): ListingLike {
  return { title: 'Item', category: 'Other', listing_type: 'sell', status: 'active', condition: 'good', price: null, created_at: '2026-06-01T00:00:00Z', ...overrides };
}

describe('listingTypeMeta', () => {
  it('finds a known type', () => {
    expect(listingTypeMeta('free').label).toBe('Free');
  });
  it('falls back to first for unknown', () => {
    expect(listingTypeMeta('bogus' as never).label).toBe('For Sale');
  });
});

describe('conditionLabel', () => {
  it('returns label', () => {
    expect(conditionLabel('like_new')).toBe('Like New');
  });
});

describe('activeListings', () => {
  it('filters to active only', () => {
    const items = [
      listing({ id: 'a', status: 'active' }),
      listing({ id: 'b', status: 'sold' }),
      listing({ id: 'c', status: 'active' }),
    ];
    expect(activeListings(items)).toHaveLength(2);
  });
});

describe('listingsByCategory', () => {
  it('groups active listings by category', () => {
    const items = [
      listing({ id: 'a', category: 'Toys' }),
      listing({ id: 'b', category: 'Books' }),
      listing({ id: 'c', category: 'Toys' }),
      listing({ id: 'd', category: 'Toys', status: 'sold' }),
    ];
    const result = listingsByCategory(items);
    expect(result[0]).toEqual({ category: 'Toys', count: 2 });
    expect(result[1]).toEqual({ category: 'Books', count: 1 });
  });
});

describe('listingsByType', () => {
  it('groups active listings by type', () => {
    const items = [
      listing({ id: 'a', listing_type: 'sell' }),
      listing({ id: 'b', listing_type: 'free' }),
      listing({ id: 'c', listing_type: 'sell' }),
    ];
    const result = listingsByType(items);
    expect(result.find((t) => t.type === 'sell')?.count).toBe(2);
    expect(result.find((t) => t.type === 'free')?.count).toBe(1);
  });
});

describe('marketplaceSummary', () => {
  it('handles empty', () => {
    const s = marketplaceSummary([]);
    expect(s.text).toBe('No listings yet');
    expect(s.total).toBe(0);
  });
  it('reports active and sold counts', () => {
    const items = [
      listing({ id: 'a', status: 'active' }),
      listing({ id: 'b', status: 'sold' }),
      listing({ id: 'c', status: 'active' }),
    ];
    const s = marketplaceSummary(items);
    expect(s.active).toBe(2);
    expect(s.text).toContain('2 active');
    expect(s.text).toContain('1 sold/traded');
  });
});

describe('fmtPrice', () => {
  it('formats amount', () => {
    expect(fmtPrice(50)).toBe('$50');
  });
  it('returns Free for null', () => {
    expect(fmtPrice(null)).toBe('Free');
  });
  it('returns Free for zero', () => {
    expect(fmtPrice(0)).toBe('Free');
  });
});

describe('fmtDate', () => {
  it('formats a date', () => {
    expect(fmtDate('2026-06-24')).toBe('Jun 24, 2026');
  });
  it('returns dash for null', () => {
    expect(fmtDate(null)).toBe('—');
  });
});
