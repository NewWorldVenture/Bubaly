// Pure helpers behind the auth provider (unit-tested from the repo root).

/** Turn Supabase auth error strings into copy a person can act on. */
export function friendlyAuthError(message: string | null | undefined): string {
  const m = (message ?? '').toLowerCase();
  if (!m) return 'Something went wrong. Please try again.';
  if (m.includes('invalid login credentials') || m.includes('invalid_credentials')) return 'That email and password don’t match.';
  if (m.includes('email not confirmed')) return 'Confirm your email first — check your inbox for the link.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Wait a minute and try again.';
  if (m.includes('network') || m.includes('fetch')) return 'Can’t reach Bubaly. Check your connection and try again.';
  return message ?? 'Something went wrong. Please try again.';
}

export function validateCredentials(email: string, password: string): string | null {
  const e = email.trim();
  if (!e) return 'Enter your email.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'That doesn’t look like an email address.';
  if (!password) return 'Enter your password.';
  return null;
}

/**
 * Is this auth failure transient — a network blip, a timeout, a rate limit, a
 * Supabase 5xx — rather than a real "your session is gone"?
 *
 * Mirrors `isRetryableAuthError` in lib/auth/session.ts (parity is asserted in
 * the root test suite). It is duplicated rather than imported because Metro
 * only bundles this project and ../design, so a runtime import from the web
 * app's lib/ would not resolve — unlike the type-only imports elsewhere here.
 *
 * On this side it decides whether a cold start with no network shows the sign-in
 * screen. The refresh token is still in the Keychain and the auto-refresh ticker
 * will use it the moment the network returns, so a transient failure must not be
 * read as "signed out".
 */
export function isRetryableAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };

  if (e.name === 'AuthRetryableFetchError') return true;

  const status = typeof e.status === 'number' ? e.status : null;
  if (status !== null && (status === 0 || status === 408 || status === 429 || status >= 500)) return true;

  const code = typeof e.code === 'string' ? e.code : '';
  if (/^(?:network_error|request_timeout|over_request_rate_limit|unexpected_failure)$/.test(code)) return true;

  const message = typeof e.message === 'string' ? e.message : '';
  return /fetch failed|network ?error|failed to fetch|timed? ?out|econnreset|enotfound|eai_again|socket hang up/i.test(message);
}
