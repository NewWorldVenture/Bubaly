import { describe, expect, it } from 'vitest';
import {
  daysUntil, expiryStatus, isLowStock, expiringSoon, lowStockItems,
  groupByLocation, pantrySummary,
} from '@/lib/pantry/logic';

const NOW = new Date('2026-06-23T12:00:00Z').getTime();
const inDays = (d: number) => new Date(NOW + d * 86400000).toISOString().slice(0, 10);

describe('daysUntil', () => {
  it('counts whole days, ignoring time of day', () => {
    expect(daysUntil(inDays(0), NOW)).toBe(0);
    expect(daysUntil(inDays(3), NOW)).toBe(3);
    expect(daysUntil(inDays(-2), NOW)).toBe(-2);
  });
  it('returns null for missing/invalid', () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil('not-a-date', NOW)).toBeNull();
  });
});

describe('expiryStatus', () => {
  it('flags expired', () => {
    const s = expiryStatus(inDays(-1), NOW);
    expect(s.tone).toBe('danger');
    expect(s.expired).toBe(true);
  });
  it('treats today as danger but not expired', () => {
    const s = expiryStatus(inDays(0), NOW);
    expect(s.tone).toBe('danger');
    expect(s.expired).toBe(false);
    expect(s.label).toBe('Expires today');
  });
  it('warns within 3 days, cautions within a week, ok beyond', () => {
    expect(expiryStatus(inDays(2), NOW).tone).toBe('warning');
    expect(expiryStatus(inDays(6), NOW).tone).toBe('caution');
    expect(expiryStatus(inDays(30), NOW).tone).toBe('success');
  });
  it('neutral with no date', () => {
    expect(expiryStatus(null, NOW).tone).toBe('neutral');
  });
});

describe('low stock', () => {
  it('uses explicit threshold', () => {
    expect(isLowStock({ quantity: 2, low_threshold: 2 })).toBe(true);
    expect(isLowStock({ quantity: 3, low_threshold: 2 })).toBe(false);
  });
  it('treats staples at/below 1 as low when no threshold', () => {
    expect(isLowStock({ quantity: 1, is_staple: true })).toBe(true);
    expect(isLowStock({ quantity: 5, is_staple: true })).toBe(false);
  });
  it('non-staple without threshold is never low', () => {
    expect(isLowStock({ quantity: 0 })).toBe(false);
  });
});

describe('selection + grouping', () => {
  const items = [
    { id: 'a', expires_at: inDays(-1), location: 'fridge', quantity: 0, is_staple: true },
    { id: 'b', expires_at: inDays(2), location: 'pantry' },
    { id: 'c', expires_at: inDays(40), location: 'pantry' },
    { id: 'd', expires_at: null, location: 'freezer', quantity: 1, low_threshold: 2 },
  ];
  it('expiringSoon returns expired+near, soonest first', () => {
    const soon = expiringSoon(items, 5, NOW);
    expect(soon.map((i) => i.id)).toEqual(['a', 'b']);
  });
  it('lowStockItems finds threshold + staple lows', () => {
    expect(lowStockItems(items).map((i) => i.id).sort()).toEqual(['a', 'd']);
  });
  it('groupByLocation drops empty locations and keeps order', () => {
    const groups = groupByLocation(items);
    expect(groups.map((g) => g.location)).toEqual(['pantry', 'fridge', 'freezer']);
  });
  it('pantrySummary rolls up counts', () => {
    const s = pantrySummary(items, NOW);
    expect(s.total).toBe(4);
    expect(s.expired).toBe(1);
    expect(s.expiringSoon).toBe(2);
    expect(s.lowStock).toBe(2);
  });
});
