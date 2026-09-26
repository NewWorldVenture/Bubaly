import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Query building, transport retries and abort handling use the installed SDK.
// Next's cache is an identity boundary. Production cache storage/invalidation
// remains a separate runtime check, not inferred from this fixture.
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@/lib/supabase/server', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return { createServiceClient: () => createClient('https://audit-fixture.invalid', 'audit-fixture-service', {
    auth: { persistSession: false, autoRefreshToken: false },
  }) };
});

import { getCachedSocialLinks } from '@/lib/server/social-links';

let requests: { url: URL; signal: AbortSignal | null | undefined }[];
let respond: (signal: AbortSignal | null | undefined) => Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(() => {
  requests = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    signal?.throwIfAborted();
    requests.push({ url: new URL(input instanceof Request ? input.url : String(input)), signal });
    return respond(signal);
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('optional public social profile read', () => {
  it('does not hold the whole public layout through seven seconds of SDK retry backoff', async () => {
    respond = async () => { throw new TypeError('fixture transport failure'); };
    const started = performance.now();
    expect(await getCachedSocialLinks()).toEqual({});
    expect(performance.now() - started).toBeLessThan(2500);
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(requests.every(({ signal }) => signal?.aborted)).toBe(true);
  }, 10000);

  it('aborts a pending transport and retries successfully on a later render', async () => {
    respond = signal => new Promise((_, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const started = performance.now();
    expect(await getCachedSocialLinks()).toEqual({});
    expect(performance.now() - started).toBeLessThan(2500);
    expect(requests[0].signal?.aborted).toBe(true);
    respond = async () => json([{ value: { x: 'https://x.com/bubaly', instagram: 'javascript:bad' } }]);
    expect(await getCachedSocialLinks()).toEqual({ x: 'https://x.com/bubaly' });
    expect(requests).toHaveLength(2);
  });

  it('cancels Retry-After beyond the public render budget', async () => {
    respond = async () => json({ message: 'fixture unavailable' }, 503, { 'retry-after': '30' });
    const started = performance.now();
    expect(await getCachedSocialLinks()).toEqual({});
    expect(performance.now() - started).toBeLessThan(2500);
    expect(requests).toHaveLength(1);
    expect(requests[0].signal?.aborted).toBe(true);
  });

  it('keeps a successful empty setting and reads only the social-links key', async () => {
    respond = async () => json([{ value: {} }]);
    expect(await getCachedSocialLinks()).toEqual({});
    expect(requests).toHaveLength(1);
    expect(requests[0].url.pathname).toBe('/rest/v1/app_settings');
    expect(requests[0].url.searchParams.get('key')).toBe('eq.social_links');
    expect(console.error).not.toHaveBeenCalled();
  });
});
