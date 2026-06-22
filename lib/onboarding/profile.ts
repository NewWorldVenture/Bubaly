// lib/onboarding/profile.ts — pure helpers for the onboarding profile step.
// Name splitting/joining and phone normalization are deterministic, so they're
// unit-tested here; the server action does the DB write.

/** Splits a stored full name into first / last for prefilling the form. */
export function splitFullName(full: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** Joins first + last into a single full name (collapsing whitespace). */
export function joinName(firstName: string, lastName: string): string {
  return [firstName, lastName].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
}

/**
 * Normalizes a phone number for storage: keeps digits, preserves a single
 * leading "+" for international numbers, drops everything else. Returns '' when
 * there are no digits. We store the normalized form but never reject odd input
 * harder than "must contain enough digits" — validation lives in the schema.
 */
export function normalizePhone(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

/** A pragmatic "looks like a phone number" check (7–15 digits, E.164-ish). */
export function isLikelyPhone(raw: string | null | undefined): boolean {
  const digits = normalizePhone(raw).replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}
