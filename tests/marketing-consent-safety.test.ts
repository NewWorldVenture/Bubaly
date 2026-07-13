import { describe, expect, it } from 'vitest';
import { isValidConsentMap } from '@/lib/marketing/consent';

describe('public consent payload safety', () => {
  it('accepts only finite known boolean categories', () => {
    expect(isValidConsentMap({ analytics: true, marketing_email: false })).toBe(true);
    expect(isValidConsentMap({ analytics: 'yes' })).toBe(false);
    expect(isValidConsentMap({ unknown: true })).toBe(false);
    expect(isValidConsentMap({ analytics: true, personalization: false, marketing_email: true, marketing_sms: false, necessary: true, extra: false })).toBe(false);
    expect(isValidConsentMap(null)).toBe(false);
  });
});
