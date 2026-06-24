// Lightweight, dependency-free client-side validators for form fields.
// Intentionally permissive — these catch obvious typos before a write, not
// enforce strict standards (the DB + server schemas remain the source of truth).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True for a plausible email address. Empty string is NOT valid. */
export function isValidEmail(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && v.length <= 254 && EMAIL_RE.test(v);
}

/**
 * True for a plausible phone number. Accepts digits, spaces, and the common
 * separators ( ) + - . — requires at least 7 digits (shortest real numbers).
 */
export function isValidPhone(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (!/^[+\d][\d\s().-]*$/.test(v)) return false;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/** Trim + enforce a max length; returns the trimmed value or null if empty. */
export function cleanText(value: string | null | undefined, max = 500): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  return v.slice(0, max);
}
