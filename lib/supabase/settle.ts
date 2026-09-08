// Transport failures must degrade like query failures, not take the page down.
//
// A Supabase query builder RESOLVES with { data, error } for anything the
// database actually answers — including every error it reports. It REJECTS only
// when the request never completed: DNS, TCP, TLS, an aborted or timed-out
// fetch. Those are exactly the failures an overloaded or unreachable database
// produces, and they are invisible to the `if (res.error)` checks a page is
// built around.
//
// Inside `Promise.all` that difference is the whole problem. One rejection
// rejects the batch, so a page that carefully logs res.error for all twenty of
// its reads still dies on an unhandled rejection and renders the error boundary
// — "This page hit a snag" — instead of the degraded view it was designed to
// show. That is what took out /dashboard while the production database was
// reporting CONNECT_TIMEOUT.
//
// `settleAll` keeps the tuple shape and the destructuring exactly as they were,
// and substitutes { data: null, count: null, error } for anything that rejected.
// The caller's existing error handling then runs for transport failures too.
//
// This is deliberately NOT a retry and NOT a cache. It only ensures that a
// failure the page already knows how to survive is delivered in the shape the
// page expects.

/** What a rejected query becomes: the shape every caller already handles. */
export type SettledFallback = { data: null; count: null; error: { message: string } };

function toFallback(cause: unknown): SettledFallback {
  return {
    data: null,
    count: null,
    error: { message: cause instanceof Error ? cause.message : String(cause) },
  };
}

/** Resolve one query, turning a transport rejection into { data: null, error }. */
export function settle<T>(query: PromiseLike<T>): Promise<T | SettledFallback> {
  return Promise.resolve(query).then((value) => value, toFallback);
}

/**
 * `Promise.all` for Supabase reads: never rejects, so one unreachable table
 * cannot cost the caller every other result it already has in hand.
 */
export function settleAll<T extends readonly PromiseLike<unknown>[] | []>(
  queries: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> | SettledFallback }> {
  return Promise.all(queries.map((query) => settle(query))) as Promise<{
    -readonly [K in keyof T]: Awaited<T[K]> | SettledFallback;
  }>;
}

// ---------------------------------------------------------------------------
// Describing a failed read
// ---------------------------------------------------------------------------

/**
 * The error shape a Postgrest failure can actually arrive in. `message` is the
 * only field `SettledFallback` guarantees; a real `PostgrestError` also carries
 * `code`, `details` and `hint`, any of which may be the only populated one.
 */
type ReadErrorLike = {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

/**
 * A human-readable reason for a failed read, guaranteed non-blank.
 *
 * `error.message` is empty more often than it looks. A count read is sent as
 * `HEAD` (`{ count: 'exact', head: true }`), and PostgREST returns no body on a
 * HEAD — so supabase-js has nothing to parse and hands back an error whose
 * message is the empty string. `error.message ?? 'unknown'` does not catch that:
 * `??` only fires on null/undefined, and `''` is neither. The banner then
 * rendered "families (count): " with the reason missing on exactly the reads
 * whose failure most needed explaining.
 *
 * So fall through every field that might carry the reason, and only then give up.
 */
export function describeReadError(error: unknown): string {
  if (error == null) return 'unknown error';
  if (typeof error === 'string') return error.trim() || 'unknown error';
  if (error instanceof Error) return error.message.trim() || error.name || 'unknown error';
  if (typeof error === 'object') {
    const { message, code, details, hint } = error as ReadErrorLike;
    for (const candidate of [message, code, details, hint]) {
      const text = typeof candidate === 'string' ? candidate.trim() : '';
      if (text !== '') return text;
    }
    return 'unknown error';
  }
  return String(error);
}

/**
 * Whether Supabase rejected the CREDENTIAL rather than the query.
 *
 * These are worth separating because they are not a per-table problem and no
 * amount of retrying or migrating fixes them: every read fails identically, so
 * the banner would otherwise repeat one cryptic string a dozen times without
 * once saying what to do about it.
 *
 * The signatures, all observed from PostgREST/GoTrue/Storage:
 *   "Unregistered API key"  — the key is well-formed but not this project's
 *   "Invalid API key"       — rejected outright (revoked, or another project's)
 *   "No API key found..."   — the header never arrived (env var unset/blank)
 *   "Invalid Compact JWS"   — not a JWT at all: truncated, quoted, or wrapped
 */
export function isCredentialError(error: unknown): boolean {
  const text = describeReadError(error).toLowerCase();
  // `jws` rather than the fuller "compact jws": Storage reports the malformed
  // key as "Invalid Compact JWS", but GoTrue reports the same underlying fault
  // as "JWSError JWSInvalidSignature". Both are the credential, not the query.
  return (
    text.includes('api key')
    || text.includes('jws')
    || text.includes('jwt')
  );
}

/**
 * What to actually do about a rejected service-role key.
 *
 * Deliberately names the variable and the place it lives: an administrator
 * looking at this banner has no way to guess that twelve identical
 * "Unregistered API key" lines mean one wrong environment variable.
 */
export const SERVICE_ROLE_KEY_HINT =
  'Supabase rejected this deployment’s service-role key, which is why every read below failed the same way. '
  + 'Set SUPABASE_SERVICE_ROLE_KEY to this project’s current service_role key under '
  + 'Vercel → Settings → Environment Variables (Production), then redeploy.';

/**
 * The hint to show above a list of failures, or undefined when the failures are
 * ordinary per-table errors that the list already explains well enough.
 *
 * Takes the already-formatted strings rather than the raw results so a caller
 * adds one line and changes nothing else; `describeReadError` has by then folded
 * every error shape into the text being matched.
 */
export function credentialHint(
  failures: readonly string[],
  // What is actually configured, from describeConfiguredServiceKey(). Optional
  // so a caller with no access to the server env still gets the generic hint.
  configured?: string | null,
): string | undefined {
  if (!failures.some(isCredentialError)) return undefined;
  return configured ? `${configured} ${SERVICE_ROLE_KEY_HINT}` : SERVICE_ROLE_KEY_HINT;
}
