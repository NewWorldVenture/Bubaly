import 'server-only';

/**
 * A TIMEOUT wrapper. It performs no URL validation of any kind.
 *
 * It was called `fetchExternal`, in `external-fetch.ts`, in a directory whose
 * other members — `public-document-fetch.ts`, `public-media-fetch.ts`,
 * `public-calendar-fetch.ts` — really are SSRF guards. The name, the filename
 * and the company it keeps all read as "the safe outbound fetch", and it is
 * not one: it adds a deadline and nothing else. The audit brief that
 * commissioned this session made exactly that mistake about it, which is the
 * evidence that a developer eventually would. Audit C3-S5-04.
 *
 * Use this ONLY for a fixed, compile-time provider host. For any URL that comes
 * from a database row, a user, or a remote document, use
 * `lib/server/public-document-fetch.ts`, which resolves the host and pins the
 * resolved address into the socket.
 */
export const DEFAULT_FETCH_DEADLINE_MS = 15_000;

export function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_DEADLINE_MS,
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}
