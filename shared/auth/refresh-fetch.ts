/** Keep temporary refresh failures retryable before the auth SDK can delete
 * durable storage. Other requests and definitive token rejections pass through. */
export function createSessionRefreshFetch(supabaseUrl: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  const endpoint = new URL(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token`);
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const temporary = response.status === 408 || response.status === 429 || (response.status >= 500 && response.status <= 599);
    if (!temporary && !response.ok) return response;

    let url: URL;
    try { url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href); }
    catch { return response; }
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    if (method.toUpperCase() !== 'POST' || url.origin !== endpoint.origin || url.pathname !== endpoint.pathname
      || url.searchParams.getAll('grant_type').length !== 1 || url.searchParams.get('grant_type') !== 'refresh_token') return response;

    if (!temporary) {
      try {
        // A 2xx without a usable token pair is an incomplete provider response,
        // not evidence of revocation. The SDK otherwise turns `{}` into a
        // missing-session error and removes the saved refresh token. Inspect a
        // clone so valid responses retain their original bytes and headers.
        const value: unknown = await response.clone().json();
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const session = value as Record<string, unknown>;
          if (typeof session.access_token === 'string' && session.access_token.trim()
            && typeof session.refresh_token === 'string' && session.refresh_token.trim()
            && typeof session.token_type === 'string' && session.token_type.trim()
            && typeof session.expires_in === 'number' && Number.isFinite(session.expires_in) && session.expires_in > 0) return response;
        }
      } catch { /* truncated or unreadable response; keep the saved session */ }
    }

    // The SDK recognizes 503 as retryable, but does not recognize every timeout,
    // rate limit or infrastructure status. Return a failure it can classify;
    // never restore cookies or convert a rejected refresh into a successful one.
    void response.body?.cancel().catch(() => {});
    const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) headers.set('retry-after', retryAfter);
    return new Response(JSON.stringify({ message: 'Session refresh temporarily unavailable.' }), { status: 503, headers });
  };
}
