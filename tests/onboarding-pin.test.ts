import { describe, it, expect } from 'vitest';
import { normalizePin, isValidPin, isWeakPin, normalizeAge } from '@/lib/onboarding/pin';

describe('normalizePin', () => {
  it('strips non-digits and caps at 4', () => {
    expect(normalizePin('1a2b3c4d5')).toBe('1234');
    expect(normalizePin('  9 9 ')).toBe('99');
    expect(normalizePin('')).toBe('');
  });
});

describe('isValidPin', () => {
  it('accepts exactly 4 digits', () => {
    expect(isValidPin('0427')).toBe(true);
  });
  it('rejects wrong length or non-digits', () => {
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('12345')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin('')).toBe(false);
  });
});

describe('isWeakPin', () => {
  it('flags repeats and strict runs', () => {
    expect(isWeakPin('0000')).toBe(true);
    expect(isWeakPin('1111')).toBe(true);
    expect(isWeakPin('1234')).toBe(true);
    expect(isWeakPin('4321')).toBe(true);
  });
  it('passes ordinary PINs', () => {
    expect(isWeakPin('0427')).toBe(false);
    expect(isWeakPin('8135')).toBe(false);
  });
  it('returns false for invalid input (nothing to judge)', () => {
    expect(isWeakPin('12')).toBe(false);
  });
});

describe('normalizeAge', () => {
  it('accepts in-range numbers/strings', () => {
    expect(normalizeAge('9')).toBe(9);
    expect(normalizeAge(42)).toBe(42);
    expect(normalizeAge('9.7')).toBe(9);
  });
  it('rejects out-of-range / junk', () => {
    expect(normalizeAge('0')).toBe(null);
    expect(normalizeAge('200')).toBe(null);
    expect(normalizeAge('abc')).toBe(null);
    expect(normalizeAge('')).toBe(null);
    expect(normalizeAge(null)).toBe(null);
  });
});
