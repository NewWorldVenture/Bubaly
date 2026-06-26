import { describe, it, expect } from 'vitest';
import {
  positionValue, positionCost, portfolioValue, portfolioCost,
  gainLossCents, gainLossPct, allocationBreakdown, projectGrowth,
  sharesForBudget, orderAmountCents, type Holding, type PriceMap,
} from '@/lib/invest/portfolio';

const holdings: Holding[] = [
  { assetId: 'a', shares: 2, avgCostCents: 5000 },   // cost 10000
  { assetId: 'b', shares: 1, avgCostCents: 8000 },   // cost 8000
];
const prices: PriceMap = { a: 6000, b: 7000 };        // value a=12000, b=7000

describe('position + portfolio math', () => {
  it('computes position value/cost', () => {
    expect(positionValue(holdings[0], prices)).toBe(12000);
    expect(positionCost(holdings[0])).toBe(10000);
  });
  it('sums the portfolio', () => {
    expect(portfolioValue(holdings, prices)).toBe(19000);
    expect(portfolioCost(holdings)).toBe(18000);
  });
  it('computes gain/loss in cents and percent', () => {
    expect(gainLossCents(holdings, prices)).toBe(1000);
    expect(gainLossPct(holdings, prices)).toBeCloseTo((1000 / 18000) * 100, 5);
  });
  it('returns 0% gain when nothing invested', () => {
    expect(gainLossPct([], {})).toBe(0);
  });
  it('handles missing prices as 0', () => {
    expect(positionValue({ assetId: 'x', shares: 5, avgCostCents: 100 }, prices)).toBe(0);
  });
});

describe('allocationBreakdown', () => {
  it('returns each asset share of value, summing ~100', () => {
    const b = allocationBreakdown(holdings, prices);
    expect(b.a).toBeCloseTo((12000 / 19000) * 100, 5);
    expect(b.b).toBeCloseTo((7000 / 19000) * 100, 5);
    expect(b.a + b.b).toBeCloseTo(100, 5);
  });
  it('is empty when no value', () => {
    expect(allocationBreakdown([], {})).toEqual({});
  });
});

describe('projectGrowth (compound teaching tool)', () => {
  it('grows principal with monthly contributions', () => {
    // $100 start, $10/mo, 0% → just the contributions added
    expect(projectGrowth(10000, 1000, 1, 0)).toBe(10000 + 1000 * 12);
  });
  it('compounds with a positive rate (more than zero-rate)', () => {
    const withRate = projectGrowth(10000, 1000, 5, 7);
    const noRate = projectGrowth(10000, 1000, 5, 0);
    expect(withRate).toBeGreaterThan(noRate);
  });
  it('returns the principal for 0 years', () => {
    expect(projectGrowth(5000, 1000, 0, 10)).toBe(5000);
  });
});

describe('order helpers', () => {
  it('computes affordable shares (4dp floor)', () => {
    expect(sharesForBudget(10000, 6000)).toBe(1.6666);
    expect(sharesForBudget(0, 6000)).toBe(0);
    expect(sharesForBudget(10000, 0)).toBe(0);
  });
  it('computes order amount rounded to whole cents', () => {
    expect(orderAmountCents(1.5, 5000)).toBe(7500);
    expect(orderAmountCents(1.6666, 6000)).toBe(10000); // Math.round(9999.6)
  });
});
