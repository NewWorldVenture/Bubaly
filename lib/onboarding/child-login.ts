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

/** The domain every kid login's synthetic address is on. Nothing is ever
 *  delivered there. */
export const CHILD_LOGIN_EMAIL_DOMAIN = 'kids.bubaly.app';

/** The synthetic, never-emailed address for a child's auth user. Deterministic
 *  from the username, so sign-in can resolve it without storing the email. */
export function syntheticChildEmail(username: string): string {
  return `child.${username}@${CHILD_LOGIN_EMAIL_DOMAIN}`;
}

/**
 * Whether an account is a kid login, read from its address in any case.
 *
 * A kid login belongs to the family whose parent made it. Because its address
 * is deterministic from the username, any household's parent can write an
 * invite to it, and accept_invite compared only addresses (until the held
 * 0495), so a child who opened a stranger's join link was enrolled in that
 * stranger's family, where its adults could message them and their own
 * parents could not see it. The join page refuses such an account before it
 * asks the database to accept.
 */
export function isChildLoginEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.trim().toLowerCase().endsWith(`@${CHILD_LOGIN_EMAIL_DOMAIN}`);
}
