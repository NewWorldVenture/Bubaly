import { describe, it, expect } from 'vitest';
import {
  percentile, priceBand, assessPrice, dealLabel, bandSummary,
  discountVsMedianPercent, isDeal, type Comp,
} from '@/lib/marketplace/price-coach';

const comp = (priceCents: number, condition = 'good'): Comp => ({ category: 'sports', condition, priceCents, kind: 'sell' });

describe('percentile', () => {
  it('interpolates', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.25)).toBe(17.5);
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('priceBand', () => {
  const comps = [comp(2000), comp(3000), comp(4000), comp(5000), comp(6000)]; // $20..$60 good
  it('builds a condition-normalized band from ≥3 comps', () => {
    const b = priceBand('sports', 'good', comps)!;
    expect(b.sampleSize).toBe(5);
    expect(b.medianCents).toBe(4000);
    expect(b.lowCents).toBeLessThan(b.medianCents);
    expect(b.highCents).toBeGreaterThan(b.medianCents);
  });
  it('needs at least 3 comps', () => {
    expect(priceBand('sports', 'good', [comp(2000), comp(3000)])).toBeNull();
  });
  it('ignores other categories, non-sell, and unpriced comps', () => {
    const mixed: Comp[] = [
      comp(2000), comp(3000), comp(4000),
      { category: 'toys', condition: 'good', priceCents: 999999, kind: 'sell' },
      { category: 'sports', condition: 'good', priceCents: 5000, kind: 'rent' },
      { category: 'sports', condition: 'good', priceCents: null, kind: 'sell' },
    ];
    expect(priceBand('sports', 'good', mixed)!.sampleSize).toBe(3);
  });
  it('adjusts the band up for a better condition', () => {
    const good = priceBand('sports', 'good', comps)!;
    const brandNew = priceBand('sports', 'new', comps)!;
    expect(brandNew.medianCents).toBeGreaterThan(good.medianCents);
  });
});

describe('assessPrice', () => {
  const band = { lowCents: 3000, medianCents: 4000, highCents: 5000, sampleSize: 8 };
  it('classifies against the band', () => {
    expect(assessPrice(2500, band)).toBe('great_deal');
    expect(assessPrice(3000, band)).toBe('great_deal');
    expect(assessPrice(3800, band)).toBe('good_deal');
    expect(assessPrice(4500, band)).toBe('fair');
    expect(assessPrice(6000, band)).toBe('above_market');
  });
  it('is unknown without a band or price', () => {
    expect(assessPrice(4000, null)).toBe('unknown');
    expect(assessPrice(0, band)).toBe('unknown');
  });
});

describe('deal ranking helpers', () => {
  const band = { lowCents: 3000, medianCents: 4000, highCents: 5000, sampleSize: 8 };
  it('discountVsMedianPercent measures depth below median only', () => {
    expect(discountVsMedianPercent(3000, band)).toBe(25); // $30 vs $40 median
    expect(discountVsMedianPercent(4000, band)).toBe(0);  // at median
    expect(discountVsMedianPercent(4500, band)).toBe(0);  // above median
    expect(discountVsMedianPercent(3000, null)).toBe(0);
  });
  it('isDeal is true at/below median only', () => {
    expect(isDeal(2500, band)).toBe(true);   // great
    expect(isDeal(3800, band)).toBe(true);   // good
    expect(isDeal(4500, band)).toBe(false);  // fair — not a deal
    expect(isDeal(6000, band)).toBe(false);  // above market
    expect(isDeal(3000, null)).toBe(false);
  });
});

describe('labels & summary', () => {
  it('labels every deal (and null for unknown)', () => {
    expect(dealLabel('great_deal')).toEqual({ text: 'Great price', tone: 'ok' });
    expect(dealLabel('above_market')).toEqual({ text: 'Above similar items', tone: 'warn' });
    expect(dealLabel('unknown')).toBeNull();
  });
  it('summarizes the range', () => {
    expect(bandSummary({ lowCents: 2000, medianCents: 3500, highCents: 4500, sampleSize: 6 })).toBe('Similar items: $20–$45');
    expect(bandSummary(null)).toBeNull();
  });
});
