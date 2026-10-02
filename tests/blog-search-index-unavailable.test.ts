import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Review 5372934636 on #709. With a read budget in lib/blog/posts.ts, a stalled
// data API makes getAllPosts degrade to [] after 4 s. The search-index route
// served that [] as a successful, CDN-cacheable index (s-maxage=300,
// stale-while-revalidate=3600), and the typeahead then said "no articles found"
// for every query on that mount. An outage is not an empty blog: it must not be
// cached as one, and the client must be able to try again.
//
// The data API here is synthetic. A stalled request settles only when its
// abort signal fires; the budget's timer is replaced so the test decides when
// it runs out. No network, database or provider is involved.
let budgets: AbortController[] = [];
let answer: 'stall' | 'empty' = 'stall';

beforeEach(() => {
  budgets = [];
  answer = 'stall';
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    budgets.push(controller);
    return controller.signal;
  });
  vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
    if (answer === 'empty') {
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    const signal = init?.signal;
    return new Promise((_, reject) => {
      const fail = () => reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) fail(); else signal?.addEventListener('abort', fail, { once: true });
    });
  }));
  vi.doMock('@/lib/server/rate-limit', () => ({
    rateLimit: () => ({ ok: true, remaining: 59, retryAfter: 0 }),
    clientIp: () => '127.0.0.1',
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.doUnmock('@/lib/server/rate-limit');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function requestIndex(): Promise<Response> {
  const { GET } = await import('@/app/api/blog/search-index/route');
  const pending = GET({ headers: new Headers() } as never);
  // Let the read start, then end its budget, as a stalled data API would.
  for (let round = 0; round < 10; round += 1) {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    for (const controller of budgets) if (!controller.signal.aborted) controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }
  return pending;
}

describe('the blog search index when the data API stalls', () => {
  it('answers unavailable, not an empty index, and nothing may cache it', async () => {
    const res = await requestIndex();
    expect(budgets.length).toBeGreaterThan(0);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cache-Control')).not.toContain('s-maxage');
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(Array.isArray(await res.json())).toBe(false);
  });

  it('still serves a genuinely empty blog as a successful, cacheable empty index', async () => {
    answer = 'empty';
    const res = await requestIndex();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=300');
    expect(await res.json()).toEqual([]);
  });
});
