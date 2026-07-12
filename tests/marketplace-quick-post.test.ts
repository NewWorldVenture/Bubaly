import { describe, expect, it } from 'vitest';
import { draftListing, extractPriceCents, suggestPriceCents, type Comparable } from '@/lib/marketplace/quick-post';

describe('extractPriceCents', () => {
  it('reads $, words, and "asking" prices', () => {
    expect(extractPriceCents('balance bike $40')).toBe(4000);
    expect(extractPriceCents('bike $12.50 obo')).toBe(1250);
    expect(extractPriceCents('about 25 bucks')).toBe(2500);
    expect(extractPriceCents('asking 15 for it')).toBe(1500);
    expect(extractPriceCents('no price here')).toBeNull();
  });
});

describe('draftListing', () => {
  it('drafts the canonical one-liner completely', () => {
    const d = draftListing("Selling Emma's barely-used balance bike, $40, pickup in the garage");
    expect(d.kind).toBe('sell');
    expect(d.category).toBe('toys');            // balance bike → toys
    expect(d.condition).toBe('like_new');       // barely used
    expect(d.priceCents).toBe(4000);
    expect(d.location).toBe('In the garage');
    expect(d.title).toBe("Emma's balance bike");
    expect(d.description).toContain('like-new');
    expect(d.matched).toEqual(expect.arrayContaining(['category', 'condition', 'price', 'location']));
  });

  it('detects non-sell kinds', () => {
    expect(draftListing('Giving away a box of board games, free to a good home').kind).toBe('free');
    expect(draftListing('Looking for a kids desk for homework').kind).toBe('wanted');
    expect(draftListing('Renting out our pressure washer $20').kind).toBe('rent');
    expect(draftListing('Happy to lend our ladder').kind).toBe('borrow');
    expect(draftListing('Trade my Switch games for Lego').kind).toBe('swap');
  });

  it('maps categories across the vocabulary', () => {
    expect(draftListing('Winter coat size 8').category).toBe('clothing');
    expect(draftListing('Ikea desk and chair').category).toBe('furniture');
    expect(draftListing('Cordless drill, works great').category).toBe('tools');
    expect(draftListing('Graco stroller').category).toBe('baby');
    expect(draftListing('Something mysterious').category).toBe('other');
  });

  it('cleans the title of intent/price/condition noise and caps length', () => {
    const d = draftListing('For sale: brand new soccer cleats size 3 $25 obo');
    expect(d.title.toLowerCase()).toContain('soccer cleats size 3');
    expect(d.title).not.toMatch(/\$|for sale|brand new|obo/i);
    const long = draftListing(`Selling ${'very '.repeat(30)}nice couch`);
    expect(long.title.length).toBeLessThanOrEqual(70);
  });

  it('always yields a usable draft even from bare input', () => {
    const d = draftListing('red wagon');
    expect(d.title).toBe('Red wagon');
    expect(d.kind).toBe('sell');
    expect(d.condition).toBeNull();
    expect(d.description.length).toBeGreaterThan(10);
  });
});

describe('suggestPriceCents', () => {
  const comp = (price: number, condition = 'good', category = 'toys', kind = 'sell'): Comparable =>
    ({ category, condition, price_cents: price, kind });

  it('takes the category median, adjusted for condition', () => {
    const comps = [comp(2000), comp(4000), comp(6000)];
    // median 4000 at 'good' baseline; like_new ×1.1 = 4400
    expect(suggestPriceCents('toys', 'like_new', comps)).toBe(4400);
    expect(suggestPriceCents('toys', 'good', comps)).toBe(4000);
    expect(suggestPriceCents('toys', 'worn', comps)).toBe(2400);
  });

  it('normalizes comps by their own condition first', () => {
    // A "new" comp at 5000 normalizes to 4000 baseline (÷1.25).
    expect(suggestPriceCents('toys', 'good', [comp(5000, 'new'), comp(4000, 'good')])).toBe(4000);
  });

  it('needs at least two same-category sell comps', () => {
    expect(suggestPriceCents('toys', 'good', [comp(4000)])).toBeNull();
    expect(suggestPriceCents('books', 'good', [comp(4000), comp(2000)])).toBeNull(); // wrong category
    expect(suggestPriceCents('toys', 'good', [comp(4000, 'good', 'toys', 'rent'), comp(2000)])).toBeNull(); // rent excluded
  });
});
