import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeOtp, isValidOtp, isLikelyE164, formatCountdown, classifyPhoneAuthError } from '@/lib/auth/otp';

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

// ROLE-L02: phone sign-in toasted the provider's own English wording (and an
// English sentence built here) to every reader. The kinds below become
// catalogue keys in the component; nothing the provider wrote reaches the toast.
describe('classifyPhoneAuthError', () => {
  it('reads an unconfigured or failing SMS provider as unavailable', () => {
    expect(classifyPhoneAuthError(new Error('Unsupported phone provider'))).toBe('provider_unavailable');
    expect(classifyPhoneAuthError({ code: 'sms_send_failed', message: 'Error sending sms OTP' })).toBe('provider_unavailable');
    expect(classifyPhoneAuthError({ code: 'phone_provider_disabled', message: 'Phone signups are disabled' })).toBe('provider_unavailable');
  });
  it('reads a wrong or stale code as rejected', () => {
    expect(classifyPhoneAuthError({ code: 'otp_expired', message: 'Token has expired or is invalid' })).toBe('code_rejected');
    expect(classifyPhoneAuthError(new Error('Token has expired or is invalid'))).toBe('code_rejected');
  });
  it('leaves everything else to the login form\'s handling', () => {
    expect(classifyPhoneAuthError({ code: 'over_request_rate_limit', message: 'Request rate limit reached' })).toBe('other');
    expect(classifyPhoneAuthError(null)).toBe('other');
  });
});

describe('the phone sign-in toast is in the reader\'s language', () => {
  const source = readFileSync('components/auth/phone-auth.tsx', 'utf8');
  it('never toasts a provider message directly', () => {
    expect(source).not.toMatch(/toastError\([^)]*error\.message/);
    expect(source).not.toContain('providerHint');
    expect(source.match(/toastError\(describeFailure\(error\)\)/g)).toHaveLength(2);
  });
  it('every full catalogue says both sentences', () => {
    for (const code of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>;
      expect(messages['phoneAuth.phoneSignInIsNotAvailable'], code).toBeTruthy();
      expect(messages['phoneAuth.thatCodeDidNotWork'], code).toBeTruthy();
      if (code !== 'en-US') expect(messages['phoneAuth.thatCodeDidNotWork'], code).not.toBe("That code didn’t work. Check it, or send a new one.");
    }
  });
});
