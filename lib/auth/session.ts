// Durable sign-in: the rules that keep a signed-in user signed in until THEY
// sign out. Pure functions with no framework imports, so the browser client,
// the server client, the middleware, and their tests all share one definition
// of how long a session lives and what actually counts as signed out.

/**
 * How long a signed-in session is expected to survive, in seconds. 400 days is
 * the browser-enforced ceiling (Chrome caps Max-Age/Expires there and other
 * engines follow), so it is the longest a "stay signed in" cookie can legally
 * live, and it is what `@supabase/ssr` writes for the auth cookies. Named here
 * so the expectation is assertable rather than implied.
 */
export const SESSION_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export type DurableCookieOptions = {
  path: string;
  sameSite: 'lax';
  maxAge: number;
  secure?: boolean;
};

/**
 * Cookie attributes for the Supabase auth cookies. `@supabase/ssr` merges these
 * over its own defaults and then fixes `maxAge` at the 400-day cap itself, so
 * what this pins is the scope and the transport:
 *
 *  - `path: '/'` — one session for the whole app, not per-section cookies.
 *  - `sameSite: 'lax'` — the session stays attached to top-level navigations
 *    back into the app (an emailed link, the OAuth return, a push-notification
 *    tap). `strict` would drop it on exactly those and show a signed-in user
 *    the login page.
 *  - `secure` — https only. A Secure cookie on a plain-http origin is discarded
 *    by the browser, which reads as an instant logout, so the http://localhost
 *    dev server and a Capacitor LAN shell must not get it.
 */
export function durableCookieOptions(secure: boolean): DurableCookieOptions {
  return {
    path: '/',
    sameSite: 'lax',
    maxAge: SESSION_COOKIE_MAX_AGE,
    ...(secure ? { secure: true } : {}),
  };
}

/** True for https origins, false for anything else or unparseable. */
export function isSecureOrigin(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Is this request definitively https? Conservative on purpose: an unknown or
 * malformed origin answers `false`, because wrongly marking a cookie Secure on
 * an http origin logs everyone out, while wrongly omitting it only forgoes a
 * hardening attribute. The proxy's `x-forwarded-proto` wins when present —
 * behind a TLS-terminating proxy the request URL itself often reads http.
 */
export function isSecureRequest(input: { forwardedProto?: string | null; url?: string | null }): boolean {
  const forwarded = input.forwardedProto?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  return isSecureOrigin(input.url);
}

/**
 * Supabase stores the session under `sb-<project-ref>-auth-token`, split into
 * `.0`, `.1`, … chunks when it outgrows one cookie. Matching the family rather
 * than one exact name is what lets us ask "does this request carry a session?"
 * without knowing the project ref. The PKCE `-code-verifier` cookie is
 * deliberately excluded: it is a sign-in in progress, not a session.
 */
export function isAuthCookieName(name: string): boolean {
  return /^sb-.+-auth-token(?:\.\d+)?$/.test(name);
}

/**
 * Does this request still carry a stored session? Used to tell a genuinely
 * signed-out visitor (no cookies at all → send them to /login) apart from a
 * signed-in user whose token lookup just failed (cookies present → keep them).
 */
export function hasAuthCookies(names: Iterable<string>): boolean {
  for (const name of names) if (isAuthCookieName(name)) return true;
  return false;
}

/**
 * Is this auth failure transient — a network blip, a timeout, a rate limit, a
 * Supabase 5xx — rather than a real "your session is gone"?
 *
 * This is the difference between an outage and a logout. An unreachable auth
 * server surfaces in the same shape as a rejected token, so treating every
 * failure as signed-out hands a user the login page because one request lost a
 * race with the network. Only a definitive answer from the auth server — an
 * invalid or expired token, a revoked session — ends a session.
 */
export function isRetryableAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };

  if (e.name === 'AuthRetryableFetchError') return true;

  const status = typeof e.status === 'number' ? e.status : null;
  if (status !== null && (status === 0 || status === 408 || status === 429 || status >= 500)) return true;

  const code = typeof e.code === 'string' ? e.code : '';
  if (/^(?:network_error|request_timeout|over_request_rate_limit|unexpected_failure|session_storage_unavailable)$/.test(code)) return true;

  const message = typeof e.message === 'string' ? e.message : '';
  return /fetch failed|network ?error|failed to fetch|timed? ?out|econnreset|enotfound|eai_again|socket hang up/i.test(message);
}
