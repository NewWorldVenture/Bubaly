import { describe, it, expect } from 'vitest';
import {
  priceVerdict, listingQualityTips, qualityScore,
  type PriceComparable, type QualityListing,
} from '@/lib/marketplace/seller-assistant';

const comps = (prices: number[], category = 'clothing'): PriceComparable[] =>
  prices.map((priceCents) => ({ priceCents, category, condition: 'good' }));

describe('priceVerdict', () => {
  it('returns no_data with too few comparables', () => {
    const v = priceVerdict(5000, [], { category: 'clothing' });
    expect(v.stance).toBe('no_data');
    expect(v.suggestedCents).toBeNull();
  });

  it('judges against the comparable median (great deal / fair / overpriced)', () => {
    const pool = comps([4000, 5000, 6000]); // median 5000
    expect(priceVerdict(3000, pool, { category: 'clothing' }).stance).toBe('great_deal');
    expect(priceVerdict(5200, pool, { category: 'clothing' }).stance).toBe('fair');
    expect(priceVerdict(6500, pool, { category: 'clothing' }).stance).toBe('above_market');
    expect(priceVerdict(9000, pool, { category: 'clothing' }).stance).toBe('overpriced');
  });

  it('suggests the median and only counts the right category', () => {
    const pool = [...comps([5000, 5000, 5000]), { priceCents: 100000, category: 'electronics' }];
    const v = priceVerdict(5000, pool, { category: 'clothing' });
    expect(v.suggestedCents).toBe(5000);
    expect(v.sampleSize).toBe(3); // electronics excluded
    expect(v.message).toContain('Fair');
  });

  it('narrows to same condition only when the sample stays usable', () => {
    const pool: PriceComparable[] = [
      { priceCents: 2000, category: 'clothing', condition: 'like_new' },
      { priceCents: 2000, category: 'clothing', condition: 'like_new' },
      { priceCents: 2000, category: 'clothing', condition: 'like_new' },
      { priceCents: 9000, category: 'clothing', condition: 'worn' },
    ];
    // Enough like_new comps → they win, worn outlier ignored.
    expect(priceVerdict(2000, pool, { category: 'clothing', condition: 'like_new' }).medianCents).toBe(2000);
  });
});

describe('listingQualityTips', () => {
  const bare: QualityListing = { kind: 'sell' };

  it('flags missing essentials, high severity first', () => {
    const tips = listingQualityTips(bare);
    const keys = tips.map((t) => t.key);
    expect(keys).toContain('photo');
    expect(keys).toContain('title');
    expect(keys).toContain('price'); // sale with no price
    expect(tips[0].severity).toBe('high');
  });

  it('a complete listing has no tips', () => {
    const good: QualityListing = {
      kind: 'sell', title: 'Kids balance bike', description: 'Barely used, great for ages 3-5, smooth tires.',
      category: 'sports', condition: 'like_new', photoUrl: 'x.jpg', priceCents: 4000, location: 'Garage',
    };
    expect(listingQualityTips(good)).toHaveLength(0);
  });

  it('nudges rent-vs-sale on a high-value sale item', () => {
    const pricey: QualityListing = { kind: 'sell', title: 'Road bike', description: 'Carbon frame, lightly ridden.', category: 'sports', condition: 'good', photoUrl: 'x.jpg', priceCents: 90000, location: 'Home' };
    expect(listingQualityTips(pricey).map((t) => t.key)).toContain('rent_vs_sale');
  });
});

describe('qualityScore', () => {
  it('scores completeness 0..100', () => {
    expect(qualityScore({ kind: 'sell' })).toBeLessThan(50);
    const good: QualityListing = {
      kind: 'sell', title: 'Kids balance bike', description: 'Barely used, great for ages 3-5, smooth tires.',
      category: 'sports', condition: 'like_new', photoUrl: 'x.jpg', priceCents: 4000, location: 'Garage',
    };
    expect(qualityScore(good)).toBe(100);
  });
});
