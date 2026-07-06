// Child login without an email address. A child member gets a real Supabase Auth
// user created under a *synthetic* (never-emailed) address, and logs in with a
// simple username + 4-digit PIN. These pure, client-safe helpers back both the
// parent-side "create login" action and the child-side sign-in. DOM-free +
// unit-tested. (Password derivation needs node:crypto and lives in the
// server-only sibling ./child-password.ts so this file stays browser-bundlable.)

// 3–24 chars, lowercase letters/digits, with . _ - allowed in the middle.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,22})[a-z0-9]$/;

/** Lowercase + strip whitespace so usernames are stable and case-insensitive. */
export function normalizeUsername(raw: string): string {
  return (raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

export function isValidUsername(u: string): boolean {
  return USERNAME_RE.test(u);
}

/** Suggest a handle from a display name (parent can edit before saving). */
export function suggestUsername(displayName: string): string {
  const base = normalizeUsername(displayName).replace(/[^a-z0-9]+/g, '');
  return base.length >= 2 ? base.slice(0, 20) : 'kiddo';
}

/** The synthetic, never-emailed address for a child's auth user. Deterministic
 *  from the username, so sign-in can resolve it without storing the email. */
export function syntheticChildEmail(username: string): string {
  return `child.${username}@kids.bubaly.app`;
}
