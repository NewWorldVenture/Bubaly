// lib/wallet/pay-handle.ts — Pay-ID handle rules. PURE + tested.
//
// A Pay-ID is a short alias (e.g. "mia") that resolves at /pay/<handle> to a
// child's active gift link. Handles are normalized to lowercase [a-z0-9_], 3-20
// chars, and a set of reserved words is blocked so handles can't shadow routes
// or impersonate the brand. These helpers are shared by the claim action, the
// UI's live validation, and the public resolver.

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;

/** Words we never let a family claim (route collisions + brand/abuse). */
export const RESERVED_HANDLES = new Set([
  'pay', 'gift', 'wallet', 'admin', 'api', 'app', 'login', 'logout', 'signup',
  'dashboard', 'settings', 'help', 'support', 'about', 'terms', 'privacy',
  'security', 'billing', 'money', 'bubaly', 'official', 'team', 'root', 'www',
  'me', 'you', 'null', 'undefined', 'system', 'staff',
]);

/** Lowercase, trim, drop a leading @, collapse to the allowed charset. */
export function normalizeHandle(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9_]/g, '');
}

/** A handle is valid if, once normalized, it fits the charset/length and isn't reserved. */
export function isValidHandle(raw: string | null | undefined): boolean {
  return handleError(raw) === null;
}

/** Returns a friendly validation message, or null when the handle is acceptable. */
export function handleError(raw: string | null | undefined): string | null {
  const h = normalizeHandle(raw);
  if (h.length < HANDLE_MIN) return `Use at least ${HANDLE_MIN} characters (letters, numbers, _).`;
  if (h.length > HANDLE_MAX) return `Keep it under ${HANDLE_MAX} characters.`;
  if (!/^[a-z0-9_]+$/.test(h)) return 'Only lowercase letters, numbers and underscores.';
  if (RESERVED_HANDLES.has(h)) return 'That handle is reserved — try another.';
  return null;
}

/** The public Pay-ID URL for a handle (origin has no trailing slash). */
export function payHandleUrl(origin: string, handle: string): string {
  return `${origin.replace(/\/$/, '')}/pay/${handle}`;
}
