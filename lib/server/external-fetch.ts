import 'server-only';

export const DEFAULT_EXTERNAL_FETCH_TIMEOUT_MS = 15_000;

/** Put a deadline on fixed-provider network calls without replacing a caller's signal. */
export function fetchExternal(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_EXTERNAL_FETCH_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}
