// lib/auth/otp.ts — pure helpers for the SMS one-time-code step of phone sign-in.
// No I/O here (the Supabase calls live in the client component); just validation
// + formatting so it's safe to import anywhere and easy to unit-test.

/** Keep only digits, capped at 6 — for the controlled code input. */
export function normalizeOtp(input: string): string {
  return (input ?? '').replace(/\D/g, '').slice(0, 6);
}

/** A complete 6-digit SMS code. */
export function isValidOtp(input: string): boolean {
  return /^\d{6}$/.test(input ?? '');
}

/** Loose E.164 check: a leading "+" and 8–15 digits (what Supabase phone auth wants). */
export function isLikelyE164(phone: string): boolean {
  return /^\+\d{7,15}$/.test((phone ?? '').replace(/[\s()-]/g, ''));
}

/** mm:ss for the resend countdown (clamped at 0). */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/**
 * What a phone sign-in failure means for the person holding the phone.
 *
 * The component used to toast the provider's own message, in English, to every
 * reader: GoTrue's "Token has expired or is invalid" for a mistyped code, and
 * for an unconfigured SMS provider an English sentence built here. Both are now
 * a kind the component turns into a catalogue key, so a German parent reads
 * German and nobody reads GoTrue's wording. Anything else falls through to the
 * same handling the email login form gives an auth error.
 */
export type PhoneAuthErrorKind = 'provider_unavailable' | 'code_rejected' | 'other';

export function classifyPhoneAuthError(error: unknown): PhoneAuthErrorKind {
  const e = (error && typeof error === 'object' ? error : {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : '';
  if (code === 'phone_provider_disabled' || code === 'sms_send_failed'
    || /not enabled|unsupported|provider|sms|not configured/i.test(message)) return 'provider_unavailable';
  if (code === 'otp_expired' || /token has expired or is invalid|invalid otp|otp (has )?expired/i.test(message)) return 'code_rejected';
  return 'other';
}
