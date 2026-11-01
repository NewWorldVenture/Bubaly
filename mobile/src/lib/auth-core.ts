// Pure helpers behind the auth provider (unit-tested from the repo root).

/** Turn Supabase auth error strings into copy a person can act on. */
export function friendlyAuthError(message: string | null | undefined): string {
  const m = (message ?? '').toLowerCase();
  if (!m) return 'Something went wrong. Please try again.';
  if (m.includes('invalid login credentials') || m.includes('invalid_credentials')) return 'That email and password don’t match.';
  if (m.includes('email not confirmed')) return 'Confirm your email first — check your inbox for the link.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Wait a minute and try again.';
  if (m.includes('network') || m.includes('fetch')) return 'Can’t reach Bubaly. Check your connection and try again.';
  // Anything else is the auth server's own wording ("Database error querying
  // schema", "Signups not allowed for otp"): written for whoever runs it, not
  // for the person signing in. The web forms show their fallback for these too
  // (describeDbError on a coded error); the text itself goes to the log.
  console.warn('[auth] unrecognised sign-in error', message);
  return 'Something went wrong. Please try again.';
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
  // An unknown wrapper without response metadata cannot prove revocation.
  if (e.name === 'AuthUnknownError' && e.status === undefined && e.code === undefined) return true;

  const status = typeof e.status === 'number' ? e.status : null;
  if (status !== null && (status === 0 || status === 408 || status === 429 || status >= 500)) return true;

  const code = typeof e.code === 'string' ? e.code : '';
  if (/^(?:network_error|request_timeout|over_request_rate_limit|unexpected_failure|session_storage_unavailable)$/.test(code)) return true;

  const message = typeof e.message === 'string' ? e.message : '';
  return /fetch failed|network ?error|failed to fetch|timed? ?out|econnreset|enotfound|eai_again|socket hang up/i.test(message);
}

/**
 * WHY a session read failed without proving sign-out. 'storage': the saved
 * session on this device could not be read — a missing chunk, a corrupt header,
 * an invalidated Keystore (chunked-storage.ts throws `session_storage_unavailable`).
 * 'network': the auth server could not be reached. Null when the failure is
 * definitive and the person really is signed out.
 *
 * The two used to be one boolean, and ReconnectingScreen said "Reconnecting…"
 * for both, retrying every 30 s for ever. Nothing ever rewrites the chunks
 * without a session, so a storage failure is permanent until the person signs
 * out of the device — which the copy has to tell them, because no amount of
 * waiting fixes it; and a network failure that lasts for minutes deserves more
 * than a spinner.
 */
export type RestoreReason = 'network' | 'storage';
export type RestoreIssue = { reason: RestoreReason; failures: number };

export function restoreReason(error: unknown): RestoreReason | null {
  if (!isRetryableAuthError(error)) return null;
  const code = (error as { code?: unknown }).code;
  return code === 'session_storage_unavailable' ? 'storage' : 'network';
}

/** The ceiling the retry backs off to; the first two attempts keep the auto-refresh ticker's 30 s. */
export const RESTORE_RETRY_BASE_MS = 30_000;
export const RESTORE_RETRY_MAX_MS = 300_000;
/** Consecutive network failures before the screen stops saying "Reconnecting…" (about eight minutes in). */
export const RESTORE_ESCALATE_AFTER = 6;

/** How long to wait before the next session read, after `failures` consecutive failures: 30 s, 30 s, 60 s, 120 s, 240 s, then five minutes. */
export function restoreRetryDelay(failures: number): number {
  return Math.min(RESTORE_RETRY_BASE_MS * 2 ** Math.max(0, failures - 2), RESTORE_RETRY_MAX_MS);
}

export type RestoreCopy = 'mobileAssistant.reconnecting' | 'mobileAssistant.savedSignInUnreadable' | 'mobileAssistant.stillReconnecting';

/** What ReconnectingScreen says: a transient reconnect, a reconnect that has gone on too long, or a saved sign-in this device cannot read. */
export function restoreCopy(issue: RestoreIssue | null | undefined): RestoreCopy {
  if (!issue) return 'mobileAssistant.reconnecting';
  // One storage failure can be a locked Keychain at cold start; a second, 30 s
  // later, is the device telling us the same thing twice.
  if (issue.reason === 'storage' && issue.failures >= 2) return 'mobileAssistant.savedSignInUnreadable';
  if (issue.reason === 'network' && issue.failures >= RESTORE_ESCALATE_AFTER) return 'mobileAssistant.stillReconnecting';
  return 'mobileAssistant.reconnecting';
}
