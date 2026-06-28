import { describe, it, expect } from 'vitest';
import { normalizeOtp, isValidOtp, isLikelyE164, formatCountdown, providerHint } from '@/lib/auth/otp';

describe('normalizeOtp', () => {
  it('keeps digits, caps at 6', () => {
    expect(normalizeOtp('12-34-56-78')).toBe('123456');
    expect(normalizeOtp('a1b2')).toBe('12');
    expect(normalizeOtp('')).toBe('');
  });
});

describe('isValidOtp', () => {
  it('requires exactly 6 digits', () => {
    expect(isValidOtp('123456')).toBe(true);
    expect(isValidOtp('12345')).toBe(false);
    expect(isValidOtp('1234567')).toBe(false);
    expect(isValidOtp('12a456')).toBe(false);
  });
});

describe('isLikelyE164', () => {
  it('accepts +country digits, tolerates spacing', () => {
    expect(isLikelyE164('+15551234567')).toBe(true);
    expect(isLikelyE164('+1 (555) 123-4567')).toBe(true);
    expect(isLikelyE164('+447911123456')).toBe(true);
  });
  it('rejects missing + or junk', () => {
    expect(isLikelyE164('5551234567')).toBe(false);
    expect(isLikelyE164('+12')).toBe(false);
    expect(isLikelyE164('')).toBe(false);
  });
});

describe('formatCountdown', () => {
  it('formats mm:ss and clamps', () => {
    expect(formatCountdown(30)).toBe('00:30');
    expect(formatCountdown(95)).toBe('01:35');
    expect(formatCountdown(-5)).toBe('00:00');
  });
});

describe('providerHint', () => {
  it('rewrites provider-disabled errors, passes others through', () => {
    expect(providerHint('Unsupported phone provider', 'Phone')).toMatch(/isn’t enabled yet/);
    expect(providerHint('Signups not allowed for otp', 'Phone')).toBe('Signups not allowed for otp');
    expect(providerHint('Invalid token', 'Phone')).toBe('Invalid token');
  });
});
