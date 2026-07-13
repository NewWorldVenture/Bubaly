import { describe, it, expect } from 'vitest';
import {
  dropPercent, isDrop, latestChange, totalDropPercent, lowestCents,
  isAtLowest, hasRecentDrop, priceDropBadge, historyLine, type PriceChange,
} from '@/lib/marketplace/price-history';

const ch = (oldC: number, newC: number, changedAt: string): PriceChange => ({ oldCents: oldC, newCents: newC, changedAt });

const NOW = new Date('2026-07-13T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString();

describe('dropPercent', () => {
  it('computes a whole-percent drop, 0 for non-drops', () => {
    expect(dropPercent(10000, 7500)).toBe(25);
    expect(dropPercent(10000, 10000)).toBe(0);
    expect(dropPercent(10000, 12000)).toBe(0);
    expect(dropPercent(0, 5)).toBe(0);
  });
});

describe('isDrop / latestChange', () => {
  it('detects drops', () => {
    expect(isDrop(ch(100, 80, 'x'))).toBe(true);
    expect(isDrop(ch(80, 100, 'x'))).toBe(false);
  });
  it('returns the newest change regardless of input order', () => {
    const h = [ch(100, 90, daysAgo(10)), ch(90, 80, daysAgo(2)), ch(110, 100, daysAgo(20))];
    expect(latestChange(h)?.newCents).toBe(80);
    expect(latestChange([])).toBeNull();
  });
});

describe('totalDropPercent / lowest', () => {
  const h = [ch(10000, 9000, daysAgo(20)), ch(9000, 8000, daysAgo(5))];
  it('measures earliest recorded price to current', () => {
    expect(totalDropPercent(h, 8000)).toBe(20);
  });
  it('finds the lowest ever and flags it', () => {
    expect(lowestCents(h, 8000)).toBe(8000);
    expect(isAtLowest(h, 8000)).toBe(true);
    expect(isAtLowest(h, 8500)).toBe(false);
    expect(isAtLowest([], 8000)).toBe(false);
  });
});

describe('recent drops + badge', () => {
  it('detects a drop within the window', () => {
    expect(hasRecentDrop([ch(100, 80, daysAgo(3))], 30, NOW)).toBe(true);
    expect(hasRecentDrop([ch(100, 80, daysAgo(90))], 30, NOW)).toBe(false);
    expect(hasRecentDrop([ch(80, 100, daysAgo(1))], 30, NOW)).toBe(false); // a raise
  });
  it('badges a recent drop only', () => {
    expect(priceDropBadge([ch(10000, 7500, daysAgo(2))], 7500, NOW)).toBe('Price dropped 25%');
    expect(priceDropBadge([ch(10000, 7500, daysAgo(90))], 7500, NOW)).toBeNull();
    expect(priceDropBadge([ch(7500, 10000, daysAgo(1))], 10000, NOW)).toBeNull(); // latest was a raise
    expect(priceDropBadge([], 7500, NOW)).toBeNull();
  });
});

describe('historyLine', () => {
  it('renders arrows for drops and raises', () => {
    expect(historyLine(ch(10000, 7500, 'x'))).toBe('$100.00 → $75.00 ↓');
    expect(historyLine(ch(7500, 8000, 'x'))).toBe('$75.00 → $80.00 ↑');
  });
});
