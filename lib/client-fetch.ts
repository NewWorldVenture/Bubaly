/** Fetch helper for browser-side public APIs that need a finite deadline. */
export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, {
    ...init,
    signal: init.signal ?? controller.signal,
  }).finally(() => clearTimeout(timer));
}
