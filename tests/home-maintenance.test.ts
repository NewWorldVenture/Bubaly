import { describe, expect, it } from 'vitest';
import {
  warrantyStatus, daysUntil, assetAgeYears, lifeRemaining, currentSeason,
  inventoryValue, DEFAULT_CADENCES, TRADE_FOR_CATEGORY, SEASONAL_CHECKLIST,
} from '@/lib/home/maintenance';

const isoInDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
const yearsAgo = (y: number) => new Date(Date.now() - y * 365.25 * 86400000).toISOString().slice(0, 10);

describe('warrantyStatus', () => {
  it('flags expired warranties', () => {
    expect(warrantyStatus(isoInDays(-5)).tone).toBe('danger');
    expect(warrantyStatus(isoInDays(-5)).active).toBe(false);
  });
  it('warns when expiring within 45 days', () => {
    expect(warrantyStatus(isoInDays(20)).tone).toBe('warning');
    expect(warrantyStatus(isoInDays(20)).active).toBe(true);
  });
  it('is healthy when far out', () => {
    expect(warrantyStatus(isoInDays(400)).tone).toBe('success');
  });
  it('handles no date', () => {
    expect(warrantyStatus(null).tone).toBe('neutral');
    expect(daysUntil(null)).toBeNull();
  });
});

describe('asset age + life', () => {
  it('computes whole-year age', () => {
    expect(assetAgeYears({ installed_on: yearsAgo(6) })).toBe(6);
    expect(assetAgeYears({ purchased_on: yearsAgo(3) })).toBe(3);
    expect(assetAgeYears({})).toBe(0);
  });
  it('derives remaining life from category lifespan', () => {
    const life = lifeRemaining({ installed_on: yearsAgo(9), category: 'water_heater' }); // 10y typical
    expect(life).not.toBeNull();
    expect(life!.yearsLeft).toBe(1);
    expect(life!.tone).toBe('danger'); // 90% used
  });
  it('returns null without a lifespan basis', () => {
    expect(lifeRemaining({ category: 'unknownthing' })).toBeNull();
  });
  it('prefers explicit expected_life_years', () => {
    const life = lifeRemaining({ installed_on: yearsAgo(2), expected_life_years: 20 });
    expect(life!.percentUsed).toBe(10);
    expect(life!.tone).toBe('success');
  });
});

describe('seasons + cadences + inventory', () => {
  it('returns a valid season with full checklist', () => {
    const s = currentSeason(new Date('2026-04-15'));
    expect(s).toBe('spring');
    expect(SEASONAL_CHECKLIST[s].length).toBeGreaterThan(0);
  });
  it('maps winter/summer/fall correctly', () => {
    expect(currentSeason(new Date('2026-01-10'))).toBe('winter');
    expect(currentSeason(new Date('2026-07-10'))).toBe('summer');
    expect(currentSeason(new Date('2026-10-10'))).toBe('fall');
  });
  it('HVAC has a filter-change cadence and a plumbing trade mapping for water heater', () => {
    expect(DEFAULT_CADENCES.hvac.some((c) => /filter/i.test(c.task))).toBe(true);
    expect(TRADE_FOR_CATEGORY.water_heater).toBe('plumbing');
  });
  it('sums inventory value', () => {
    expect(inventoryValue([{ purchase_price: 1200 }, { purchase_price: 800 }, { purchase_price: null }])).toBe(2000);
  });
});
