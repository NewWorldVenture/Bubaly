import { describe, it, expect } from 'vitest';
import { getSeasonalContext, applySeasonalBoost } from '@/lib/guardian/seasonal';

const d = (m: number, day: number) => new Date(Date.UTC(2026, m - 1, day, 12, 0, 0));

describe('getSeasonalContext', () => {
  it('detects tax season (Jan–Apr 18)', () => {
    expect(getSeasonalContext(d(2, 1)).season).toBe('tax_season');
    expect(getSeasonalContext(d(4, 18)).season).toBe('tax_season');
    expect(getSeasonalContext(d(1, 1)).season).toBe('tax_season');
  });

  it('detects Medicare enrollment (Oct 15 – Dec 7)', () => {
    expect(getSeasonalContext(d(10, 20)).season).toBe('medicare_enrollment');
    expect(getSeasonalContext(d(12, 7)).season).toBe('medicare_enrollment');
  });

  it('detects holiday giving in mid-December (after Medicare window)', () => {
    expect(getSeasonalContext(d(12, 20)).season).toBe('holiday_giving');
  });

  it('detects storm season in summer', () => {
    expect(getSeasonalContext(d(7, 15)).season).toBe('storm_recovery');
  });

  it('returns none for a quiet window (May)', () => {
    expect(getSeasonalContext(d(5, 10)).season).toBe('none');
    expect(getSeasonalContext(d(5, 10)).boost).toBe(0);
  });
});

describe('applySeasonalBoost', () => {
  it('boosts IRS scams during tax season', () => {
    const r = applySeasonalBoost('irs_scam', 60, d(3, 1));
    expect(r.boosted).toBe(true);
    expect(r.confidence).toBe(85); // 60 + 25
    expect(r.note).toMatch(/tax season/i);
  });

  it('caps boosted confidence at 100', () => {
    const r = applySeasonalBoost('irs_scam', 90, d(3, 1));
    expect(r.confidence).toBe(100);
  });

  it('does not boost an out-of-season scam type', () => {
    const r = applySeasonalBoost('warranty_scam', 60, d(3, 1));
    expect(r.boosted).toBe(false);
    expect(r.confidence).toBe(60);
  });

  it('does nothing when scamType is null', () => {
    const r = applySeasonalBoost(null, 60, d(3, 1));
    expect(r.boosted).toBe(false);
    expect(r.confidence).toBe(60);
  });

  it('boosts charity scams over the holidays', () => {
    const r = applySeasonalBoost('charity_scam', 50, d(12, 20));
    expect(r.boosted).toBe(true);
    expect(r.confidence).toBe(70); // 50 + 20
  });
});
