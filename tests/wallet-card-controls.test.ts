import { describe, it, expect } from 'vitest';
import {
  normalizeSpendWindow, isValidSpendWindow, clampSpendLimitCents, MAX_SPEND_LIMIT_CENTS,
  normalizeBlockedCategories, categoryLabel, BLOCKABLE_CATEGORIES, SPEND_WINDOWS,
} from '@/lib/wallet/card-controls';

describe('spend window', () => {
  it('accepts known windows', () => {
    expect(isValidSpendWindow('daily')).toBe(true);
    expect(isValidSpendWindow('per_authorization')).toBe(true);
    expect(isValidSpendWindow('nope')).toBe(false);
  });
  it('normalizes unknown to per_authorization', () => {
    expect(normalizeSpendWindow('weekly')).toBe('weekly');
    expect(normalizeSpendWindow('garbage')).toBe('per_authorization');
    expect(normalizeSpendWindow(null)).toBe('per_authorization');
  });
  it('exposes all five intervals', () => {
    expect(SPEND_WINDOWS.map((w) => w.value)).toEqual(
      ['per_authorization', 'daily', 'weekly', 'monthly', 'all_time'],
    );
  });
});

describe('clampSpendLimitCents', () => {
  it('treats blank/zero/negative as no limit', () => {
    expect(clampSpendLimitCents('')).toBeNull();
    expect(clampSpendLimitCents(null)).toBeNull();
    expect(clampSpendLimitCents(0)).toBeNull();
    expect(clampSpendLimitCents(-5)).toBeNull();
    expect(clampSpendLimitCents('abc')).toBeNull();
  });
  it('rounds to integer cents', () => {
    expect(clampSpendLimitCents(2500)).toBe(2500);
    expect(clampSpendLimitCents(2500.7)).toBe(2501);
  });
  it('caps at the maximum', () => {
    expect(clampSpendLimitCents(MAX_SPEND_LIMIT_CENTS + 999)).toBe(MAX_SPEND_LIMIT_CENTS);
  });
});

describe('normalizeBlockedCategories', () => {
  it('keeps only known categories, deduped, in catalog order', () => {
    const out = normalizeBlockedCategories(['liquor_stores', 'betting_casino_gambling', 'liquor_stores', 'not_real']);
    expect(out).toEqual(['betting_casino_gambling', 'liquor_stores']); // catalog order
  });
  it('returns [] for non-arrays', () => {
    expect(normalizeBlockedCategories('liquor_stores')).toEqual([]);
    expect(normalizeBlockedCategories(null)).toEqual([]);
  });
  it('every catalog value round-trips', () => {
    const all = BLOCKABLE_CATEGORIES.map((c) => c.value);
    expect(normalizeBlockedCategories(all)).toEqual(all);
  });
});

describe('categoryLabel', () => {
  it('maps known values to friendly labels', () => {
    expect(categoryLabel('betting_casino_gambling')).toBe('Gambling & casinos');
  });
  it('falls back to the raw value when unknown', () => {
    expect(categoryLabel('mystery')).toBe('mystery');
  });
});
