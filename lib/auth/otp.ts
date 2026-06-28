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
 * Friendlier message when a provider isn't configured yet, so users see guidance
 * instead of a raw Supabase error. Falls back to the original message.
 */
export function providerHint(message: string, label: string): string {
  return /not enabled|unsupported|provider|sms|not configured/i.test(message)
    ? `${label} sign-in isn’t enabled yet. Try another option.`
    : message;
}
