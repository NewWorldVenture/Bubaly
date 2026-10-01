import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A read that ran out of its budget must never reach a shared cache as a
// successful empty index (review 5372934636 on #709). The search index is
// served with `s-maxage=300, stale-while-revalidate=3600`, so whatever the
// origin answers during an outage is what every visitor searching in the next
// hour gets, unless the answer forbids storing it.
//
// Timeline, against the real route, loaders and SDK with a synthetic data API:
//   1. the data API stalls; the request ends when its 4 s budget fires;
//   2. the data API recovers; the next request must reach the origin and get
//      the real index, not a stored failure;
//   3. after that, the shared cache serves the real index.
// The cache below follows the rule a CDN applies to these headers: a response
// with an explicit shared max-age is stored unless it says `no-store` or
// `private`. No network, CDN, database or provider is involved.
const ARTICLE = {
  slug: 'bedtime-routines-that-stick', title: 'Bedtime routines that stick', excerpt: 'Small steps that hold.',
  author: 'Bubaly', published_at: '2026-09-01T08:00:00Z', updated_at: null, reading_minutes: 4, tags: ['sleep'],
  category: 'Parenting', featured: false, accent_color: null, hero_image_url: null, hero_image_alt: null, hero_image_credit: null,
};

let dataApi: 'stalled' | 'healthy' = 'stalled';
let budgets: Array<{ ms: number; controller: AbortController }> = [];
let dataRequests = 0;

beforeEach(() => {
  dataApi = 'stalled';
  budgets = [];
  dataRequests = 0;
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    budgets.push({ ms, controller });
    return controller.signal;
  });
  vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
    dataRequests += 1;
    if (dataApi === 'healthy') {
      // One page of rows, then the empty page that ends a paged read.
      const offset = Number(new URL(String(input)).searchParams.get('offset') ?? '0');
      const rows = offset === 0 ? [ARTICLE] : [];
      return Promise.resolve(new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } }));
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

type Served = { from: 'origin' | 'cache'; status: number; cacheControl: string; body: unknown };

/** A shared cache in front of the route, keyed on its one URL. */
function sharedCache() {
  let stored: Omit<Served, 'from'> | null = null;
  return {
    get stored() { return stored; },
    async request(origin: () => Promise<Response>): Promise<Served> {
      if (stored) return { from: 'cache', ...stored };
      const res = await origin();
      const cacheControl = res.headers.get('Cache-Control') ?? '';
      const served = { status: res.status, cacheControl, body: await res.json() };
      const sharedMaxAge = /s-maxage=(\d+)/.exec(cacheControl);
      if (sharedMaxAge && Number(sharedMaxAge[1]) > 0 && !/\b(no-store|private)\b/.test(cacheControl)) stored = served;
      return { from: 'origin', ...served };
    },
  };
}

async function settle() { for (let i = 0; i < 50; i += 1) await Promise.resolve(); }

async function callRoute(): Promise<Response> {
  const { GET } = await import('@/app/api/blog/search-index/route');
  const pending = GET({ headers: new Headers() } as never);
  if (dataApi === 'stalled') {
    // The read is still waiting on the data API: nothing but the budget ends it.
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await settle();
    expect(settled, 'a stalled read waits until its budget runs out').toBe(false);
    for (const { controller } of budgets) if (!controller.signal.aborted) controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }
  return pending;
}

describe('a timed-out search index read, then recovery, behind a shared cache', () => {
  it('is never stored, and the next request after recovery gets the real index', async () => {
    const cdn = sharedCache();

    // 1. The data API stalls; the bounded read gives up.
    const outage = await cdn.request(callRoute);
    expect(budgets.map((b) => b.ms)).toEqual([4_000]);
    expect(outage.from).toBe('origin');
    expect(outage.status).toBe(503);
    expect(outage.cacheControl).toBe('no-store');
    expect(outage.body).not.toEqual([]);
    expect(cdn.stored, 'the failure must not be stored as the index').toBeNull();

    // 2. The data API recovers. The request reaches the origin, not a stored
    //    failure, and the real index comes back.
    dataApi = 'healthy';
    const requestsBefore = dataRequests;
    const recovered = await cdn.request(callRoute);
    expect(recovered.from).toBe('origin');
    expect(dataRequests).toBeGreaterThan(requestsBefore);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toEqual([{ slug: ARTICLE.slug, title: ARTICLE.title, excerpt: ARTICLE.excerpt, category: ARTICLE.category }]);

    // 3. Only the healthy index is shared.
    expect(recovered.cacheControl).toContain('s-maxage=300');
    const later = await cdn.request(callRoute);
    expect(later.from).toBe('cache');
    expect(later.body).toEqual(recovered.body);
  });

  it('shares a genuinely empty blog as a successful empty index', async () => {
    dataApi = 'healthy';
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))));
    const cdn = sharedCache();
    const empty = await cdn.request(callRoute);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
    expect(cdn.stored?.body).toEqual([]);
  });
});
