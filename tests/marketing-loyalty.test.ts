import { describe, expect, it } from 'vitest';
import {
  computeTier, tierProgress, canRedeem, pointsForSpend, REWARD_KINDS,
} from '@/lib/marketing/loyalty';

const T = { silverAt: 1000, goldAt: 5000 };

describe('tiers', () => {
  it('computes tier from lifetime points', () => {
    expect(computeTier(0, T)).toBe('bronze');
    expect(computeTier(999, T)).toBe('bronze');
    expect(computeTier(1000, T)).toBe('silver');
    expect(computeTier(4999, T)).toBe('silver');
    expect(computeTier(5000, T)).toBe('gold');
  });

  it('progress within bronze band', () => {
    const p = tierProgress(500, T);
    expect(p.tier).toBe('bronze');
    expect(p.next).toBe('silver');
    expect(p.pointsToNext).toBe(500);
    expect(p.pct).toBe(50);
  });

  it('progress within silver band', () => {
    const p = tierProgress(3000, T); // halfway between 1000 and 5000
    expect(p.tier).toBe('silver');
    expect(p.next).toBe('gold');
    expect(p.pointsToNext).toBe(2000);
    expect(p.pct).toBe(50);
  });

  it('gold is maxed out', () => {
    const p = tierProgress(8000, T);
    expect(p.tier).toBe('gold');
    expect(p.next).toBeNull();
    expect(p.pointsToNext).toBe(0);
    expect(p.pct).toBe(100);
  });
});

describe('redeem + spend', () => {
  it('canRedeem checks balance', () => {
    expect(canRedeem(500, 500)).toBe(true);
    expect(canRedeem(499, 500)).toBe(false);
    expect(canRedeem(1000, -1)).toBe(false);
  });
  it('pointsForSpend floors per-dollar', () => {
    expect(pointsForSpend(2599, 1)).toBe(25);   // $25.99 → 25
    expect(pointsForSpend(1000, 2)).toBe(20);    // $10 × 2
    expect(pointsForSpend(50, 1)).toBe(0);       // $0.50 → 0
  });
  it('exposes reward kinds', () => {
    expect(REWARD_KINDS).toContain('free_month');
  });
});
