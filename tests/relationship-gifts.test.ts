import { describe, it, expect } from 'vitest';
import {
  suggestGiftsFromWishlist, buildRelationshipDigestPrompt, parseRelationshipDigest, summarizeGifts,
  type WishItemLite,
} from '@/lib/relationship/gifts';

const item = (over: Partial<WishItemLite>): WishItemLite => ({
  id: 'i', title: 't', url: null, price: 20, priority: 'medium', is_purchased: false, claimed_by: null, ...over,
});

describe('suggestGiftsFromWishlist', () => {
  it('drops purchased/claimed, ranks by priority then price, normalizes to cents', () => {
    const out = suggestGiftsFromWishlist([
      item({ id: 'a', priority: 'low', price: 10 }),
      item({ id: 'b', priority: 'high', price: 80 }),
      item({ id: 'c', priority: 'high', price: 25 }),
      item({ id: 'd', is_purchased: true, priority: 'high' }),
      item({ id: 'e', claimed_by: 'u1', priority: 'high' }),
    ]);
    expect(out.map((g) => g.wishlistItemId)).toEqual(['c', 'b', 'a']);
    expect(out[0].priceCents).toBe(2500);
  });

  it('honors a max budget and a limit', () => {
    const out = suggestGiftsFromWishlist(
      [item({ id: 'a', price: 10 }), item({ id: 'b', price: 200 }), item({ id: 'c', price: 30 })],
      { maxBudgetCents: 5000, limit: 2 },
    );
    expect(out.map((g) => g.wishlistItemId)).toEqual(['a', 'c']);
  });

  it('keeps price-less items (unknown price passes the budget)', () => {
    const out = suggestGiftsFromWishlist([item({ id: 'a', price: null })], { maxBudgetCents: 1000 });
    expect(out).toHaveLength(1);
    expect(out[0].priceCents).toBeNull();
  });
});

describe('summarizeGifts', () => {
  it('splits open vs done and sums priced items', () => {
    expect(summarizeGifts([
      { status: 'idea', price_cents: 2500 },
      { status: 'ordered', price_cents: 1000 },
      { status: 'purchased', price_cents: 5000 },
      { status: 'given', price_cents: null },
      { status: 'saved', price_cents: null },
    ])).toEqual({ total: 5, open: 3, done: 2, openCents: 3500, spentCents: 5000 });
  });
  it('handles an empty list', () => {
    expect(summarizeGifts([])).toEqual({ total: 0, open: 0, done: 0, openCents: 0, spentCents: 0 });
  });
});

describe('buildRelationshipDigestPrompt', () => {
  it('includes upcoming dates, milestones, prefs, and wishlist', () => {
    const { system, user } = buildRelationshipDigestPrompt({
      partnerName: 'Sam',
      upcoming: [{ title: 'Anniversary', kind: 'anniversary', countdown: 'in 3 days', milestone: '5th anniversary' }],
      interests: ['hiking', 'coffee'],
      loveLanguages: ['quality time'],
      giftBudgetCents: 10000,
      wishlist: [{ title: 'Trail backpack', priceCents: 8500 }],
    });
    expect(system).toMatch(/STRUCTURED JSON only/);
    expect(user).toMatch(/Sam/);
    expect(user).toMatch(/5th anniversary/);
    expect(user).toMatch(/hiking, coffee/);
    expect(user).toMatch(/\$100/);       // budget
    expect(user).toMatch(/Trail backpack/);
  });

  it('degrades gracefully with no data', () => {
    const { user } = buildRelationshipDigestPrompt({
      partnerName: null, upcoming: [], interests: [], loveLanguages: [], giftBudgetCents: null, wishlist: [],
    });
    expect(user).toMatch(/your partner/);
    expect(user).toMatch(/no upcoming dates/);
  });
});

describe('parseRelationshipDigest', () => {
  it('parses a clean JSON payload', () => {
    const r = parseRelationshipDigest(JSON.stringify({
      headline: 'Your anniversary is coming up!',
      prompts: ['Book a table', '  ', 42],
      giftIdeas: [
        { title: 'Weekend cabin', reason: 'quality time', estimatedPrice: '$300' },
        { title: '', reason: 'skip me' },
      ],
    }));
    expect(r.headline).toBe('Your anniversary is coming up!');
    expect(r.prompts).toEqual(['Book a table']);
    expect(r.giftIdeas).toEqual([{ title: 'Weekend cabin', reason: 'quality time', estimatedPrice: '$300' }]);
  });

  it('extracts JSON wrapped in prose/code fences and tolerates junk', () => {
    const r = parseRelationshipDigest('Here you go:\n```json\n{"headline":"Hi","prompts":["a"],"giftIdeas":[]}\n```');
    expect(r.headline).toBe('Hi');
    expect(r.prompts).toEqual(['a']);
    expect(parseRelationshipDigest('not json').headline).toBe('');
  });
});
