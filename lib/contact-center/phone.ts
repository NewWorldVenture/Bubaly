// Pure phone helpers for the Contact Center. Client-safe. Reuses the display
// formatter from the Guardian layer and adds E.164 normalization/validation for
// the dedicated family number. Tested in tests/contact-center-phone.test.ts.

export { formatPhone } from '@/lib/guardian/phone';

/** Normalize loose input to E.164, assuming a default country calling code
 *  (US "1") for bare 10-digit numbers. Returns null when it can't. */
export function toE164(input: string | null | undefined, defaultCc = '1'): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (hadPlus) return isE164(`+${digits}`) ? `+${digits}` : null;
  if (digits.length === 10) return isE164(`+${defaultCc}${digits}`) ? `+${defaultCc}${digits}` : null;
  if (digits.length === 11 && digits.startsWith(defaultCc)) return `+${digits}`;
  // Already includes a country code (11–15 digits) → assume E.164 without the +.
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** True for a well-formed E.164 number (+ then 8–15 digits, no leading zero). */
export function isE164(value: string | null | undefined): boolean {
  return !!value && /^\+[1-9]\d{7,14}$/.test(value);
}
