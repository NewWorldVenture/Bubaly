import { describe, expect, it } from 'vitest';
import {
  daysUntil, expiryStatus, isLowStock, expiringSoon, lowStockItems,
  groupByLocation, pantrySummary,
} from '@/lib/pantry/logic';
import { dayKeyIn } from '@/lib/time/zoned';

// A day KEY, not an instant. These helpers used to take `now: number` and find
// midnight with `setHours(0, 0, 0, 0)`, so every one of these assertions was
// really asserting something about the machine running the test.
const TODAY = '2026-06-23';
const inDays = (d: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

describe('daysUntil', () => {
  it('counts whole days between two day keys', () => {
    expect(daysUntil(inDays(0), TODAY)).toBe(0);
    expect(daysUntil(inDays(3), TODAY)).toBe(3);
    expect(daysUntil(inDays(-2), TODAY)).toBe(-2);
  });
  it('returns null for missing/invalid', () => {
    expect(daysUntil(null, TODAY)).toBeNull();
    expect(daysUntil('not-a-date', TODAY)).toBeNull();
  });
});

describe('expiryStatus', () => {
  it('flags expired', () => {
    const s = expiryStatus(inDays(-1), TODAY);
    expect(s.tone).toBe('danger');
    expect(s.expired).toBe(true);
  });
  it('treats today as danger but not expired', () => {
    const s = expiryStatus(inDays(0), TODAY);
    expect(s.tone).toBe('danger');
    expect(s.expired).toBe(false);
    expect(s.label).toBe('Expires today');
  });
  it('warns within 3 days, cautions within a week, ok beyond', () => {
    expect(expiryStatus(inDays(2), TODAY).tone).toBe('warning');
    expect(expiryStatus(inDays(6), TODAY).tone).toBe('caution');
    expect(expiryStatus(inDays(30), TODAY).tone).toBe('success');
  });
  it('neutral with no date', () => {
    expect(expiryStatus(null, TODAY).tone).toBe('neutral');
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
    const soon = expiringSoon(items, 5, TODAY);
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
    const s = pantrySummary(items, TODAY);
    expect(s.total).toBe(4);
    expect(s.expired).toBe(1);
    expect(s.expiringSoon).toBe(2);
    expect(s.lowStock).toBe(2);
  });
});

/**
 * The defect these helpers were changed for, stated where it can fail.
 *
 * Every assertion above would pass just as happily against the old
 * `setHours(0, 0, 0, 0)` implementation, because they never name an instant
 * where the host's day and the family's day disagree. This block does: 8pm in
 * California on the 23rd is already the 24th in UTC, which is the last seven
 * hours of every single day. Pick a morning instead and the whole block proves
 * nothing, which is exactly how this shipped.
 */
describe('a jar expiring tomorrow does not say "expires today" tonight', () => {
  // 2026-06-23T20:00 in Los Angeles === 2026-06-24T03:00Z.
  const EVENING_IN_LA = new Date('2026-06-24T03:00:00Z');
  const TZ = 'America/Los_Angeles';

  it('the family is still on the 23rd while the host has rolled to the 24th', () => {
    expect(dayKeyIn(EVENING_IN_LA, TZ)).toBe('2026-06-23');
    expect(EVENING_IN_LA.toISOString().slice(0, 10)).toBe('2026-06-24');
  });

  it('labels the 24th "tomorrow", not "today"', () => {
    const todayKey = dayKeyIn(EVENING_IN_LA, TZ);
    expect(expiryStatus('2026-06-24', todayKey).label).toBe('Expires tomorrow');
    expect(expiryStatus('2026-06-23', todayKey).label).toBe('Expires today');
  });

  it('does not write off food that is still good today', () => {
    const todayKey = dayKeyIn(EVENING_IN_LA, TZ);
    expect(expiryStatus('2026-06-23', todayKey).expired).toBe(false);
  });

  it('gives the AI chef a window that starts on the family’s day', () => {
    const todayKey = dayKeyIn(EVENING_IN_LA, TZ);
    const items = [
      { id: 'yoghurt', expires_at: '2026-06-23' },
      { id: 'spinach', expires_at: '2026-06-28' },
      { id: 'flour', expires_at: '2026-06-29' },
    ];
    // A 5-day window from the 23rd reaches the 28th and stops. Anchored to the
    // host's 24th it would reach the 29th and pull the flour in a day early.
    expect(expiringSoon(items, 5, todayKey).map((i) => i.id)).toEqual(['yoghurt', 'spinach']);
  });
});
