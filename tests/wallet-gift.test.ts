import { describe, it, expect } from 'vitest';
import {
  parseSuggestedAmounts, clampGiftAmountCents, isValidOccasion, giftPath, occasionLabel,
  GIFT_MIN_CENTS, GIFT_MAX_CENTS,
} from '@/lib/wallet/gift';

describe('parseSuggestedAmounts', () => {
  it('parses dollars to ascending de-duped cents', () => {
    expect(parseSuggestedAmounts('50, 25, 100, 25')).toEqual([2500, 5000, 10000]);
  });
  it('drops out-of-range and junk values, caps at 6', () => {
    expect(parseSuggestedAmounts('0, 5, abc, 2000')).toEqual([500]); // 0 too small, 2000 (>$1000) dropped
    expect(parseSuggestedAmounts('1 2 3 4 5 6 7 8')).toHaveLength(6);
  });
  it('handles empty input', () => {
    expect(parseSuggestedAmounts('')).toEqual([]);
  });
});

describe('clampGiftAmountCents', () => {
  it('accepts in-range amounts', () => {
    expect(clampGiftAmountCents(5000)).toBe(5000);
    expect(clampGiftAmountCents(GIFT_MIN_CENTS)).toBe(GIFT_MIN_CENTS);
    expect(clampGiftAmountCents(GIFT_MAX_CENTS)).toBe(GIFT_MAX_CENTS);
  });
  it('rejects out-of-range / invalid', () => {
    expect(clampGiftAmountCents(50)).toBeNull();        // < $1
    expect(clampGiftAmountCents(200000)).toBeNull();    // > $1000
    expect(clampGiftAmountCents(NaN)).toBeNull();
  });
});

describe('isValidOccasion / giftPath / occasionLabel', () => {
  it('validates occasions', () => {
    expect(isValidOccasion('birthday')).toBe(true);
    expect(isValidOccasion('nope')).toBe(false);
    expect(isValidOccasion(null)).toBe(false);
  });
  it('builds the public path', () => {
    expect(giftPath('abc123')).toBe('/gift/abc123');
  });
  it('labels occasions with a fallback', () => {
    expect(occasionLabel('birthday')).toContain('Birthday');
    expect(occasionLabel(null)).toBe('Gift');
  });
});
