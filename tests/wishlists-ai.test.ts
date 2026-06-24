import { describe, expect, it } from 'vitest';
import {
  analyzeWishlists,
  buildWishlistsPrompt,
  parseWishlistsResponse,
  type WishlistItemLike,
} from '@/lib/wishlists/wishlists-ai';

function wish(overrides: Partial<WishlistItemLike> = {}): WishlistItemLike {
  return { title: 'Lego set', price: 49.99, priority: 'medium', claimed_by: null, is_purchased: false, ...overrides };
}

describe('analyzeWishlists', () => {
  it('summarizes wish list items', () => {
    const r = analyzeWishlists([
      wish({ title: 'Book', price: 15 }),
      wish({ title: 'Game', price: 60, claimed_by: 'user1' }),
      wish({ title: 'Toy', price: 25, claimed_by: 'user2', is_purchased: true }),
    ]);
    expect(r.totalItems).toBe(3);
    expect(r.claimedCount).toBe(2);
    expect(r.purchasedCount).toBe(1);
    expect(r.totalValue).toBe(100);
    expect(r.summary).toContain('3 wishes');
  });

  it('tracks priority counts', () => {
    const r = analyzeWishlists([
      wish({ priority: 'high' }),
      wish({ priority: 'high' }),
      wish({ priority: 'low' }),
    ]);
    expect(r.priorityCounts['high']).toBe(2);
    expect(r.priorityCounts['low']).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeWishlists([]);
    expect(r.totalItems).toBe(0);
    expect(r.totalValue).toBe(0);
  });

  it('handles null prices', () => {
    const r = analyzeWishlists([wish({ price: null }), wish({ price: 30 })]);
    expect(r.totalValue).toBe(30);
  });
});

describe('buildWishlistsPrompt', () => {
  it('builds prompt with wish details', () => {
    const { system, user } = buildWishlistsPrompt([wish({ title: 'Lego Botanicals', price: 49.99 })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Lego Botanicals');
    expect(user).toContain('$49.99');
  });
});

describe('parseWishlistsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseWishlistsResponse('{"suggestions":["coordinate gifts"],"giftIdeas":["bundle items"],"budgetTip":"set a limit"}');
    expect(r.suggestions).toEqual(['coordinate gifts']);
    expect(r.giftIdeas).toEqual(['bundle items']);
    expect(r.budgetTip).toBe('set a limit');
  });

  it('handles malformed input', () => {
    const r = parseWishlistsResponse('bad');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseWishlistsResponse('```json\n{"suggestions":["x"],"giftIdeas":["y"],"budgetTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
