import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Read = { table: string; aggregate: boolean; filters: Record<string, unknown> };
type Write = { op: 'insert' | 'delete'; filters: Record<string, unknown> };
const h = vi.hoisted(() => ({
  lookupData: { id: 'published-post' } as { id: string } | null,
  lookupError: null as { message: string } | null,
  likes: [] as { post_id: string; visitor_id: string }[], reads: [] as Read[], writes: [] as Write[],
  rateAllowed: true, rate: vi.fn(), ip: vi.fn(), services: vi.fn(), forbidden: [] as string[],
}));
function refuse(name: string): never { h.forbidden.push(name); throw new Error('Forbidden synthetic operation: ' + name); }
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/rate-limit', () => ({ clientIp: () => { h.ip(); return 'synthetic-ip'; } }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => { h.rate(); return { ok: h.rateAllowed, retryAfter: 30 }; } }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: () => refuse('Auth server'),
  createServiceClient: () => { h.services(); return { from: (table: string) => {
    if (!['blog_posts', 'blog_post_likes'].includes(table)) return refuse('table ' + table);
    const state = { op: 'select' as 'select' | 'insert' | 'delete', aggregate: false, filters: {} as Record<string, unknown> };
    const terminal = () => {
      if (table === 'blog_posts') {
        if (state.op !== 'select' || state.filters.published !== true || typeof state.filters.slug !== 'string') return refuse('published post predicate');
        h.reads.push({ table, aggregate: false, filters: { ...state.filters } });
        return { data: h.lookupData, error: h.lookupError };
      }
      if (state.op === 'insert') {
        const row = { post_id: String(state.filters.post_id), visitor_id: String(state.filters.visitor_id) };
        h.writes.push({ op: 'insert', filters: { ...row } });
        if (h.likes.some(x => x.post_id === row.post_id && x.visitor_id === row.visitor_id)) return { data: null, error: { code: '23505' } };
        h.likes.push(row); return { data: null, error: null };
      }
      if (state.op === 'delete') {
        if (!state.filters.post_id || !state.filters.visitor_id) return refuse('unscoped delete');
        h.writes.push({ op: 'delete', filters: { ...state.filters } });
        h.likes = h.likes.filter(x => x.post_id !== state.filters.post_id || x.visitor_id !== state.filters.visitor_id);
        return { data: null, error: null };
      }
      if (!state.filters.post_id) return refuse('unscoped heart read');
      const rows = h.likes.filter(x => Object.entries(state.filters).every(([key, value]) => x[key as keyof typeof x] === value));
      h.reads.push({ table, aggregate: state.aggregate, filters: { ...state.filters } });
      return { data: state.aggregate ? null : rows[0] ?? null, count: rows.length, error: null };
    };
    const q = {
      select: (_fields: string, options?: { count?: string; head?: boolean }) => { state.aggregate = !!options?.count; return q; },
      eq: (key: string, value: unknown) => { state.filters[key] = value; return q; },
      insert: (row: Record<string, unknown>) => { state.op = 'insert'; state.filters = { ...row }; return q; },
      delete: () => { state.op = 'delete'; return q; },
      maybeSingle: async () => terminal(),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve().then(terminal).then(resolve, reject),
    }; return q;
  } }; },
}));
const { GET, POST } = await import('@/app/api/blog/like/route');
const OWN = 'visitor-own-0001', FOREIGN = 'visitor-other-0002';
const get = (cookie: string | null = OWN, slug = 'family-day', named?: string) => {
  const url = new URL('https://synthetic.invalid/api/blog/like'); url.searchParams.set('slug', slug);
  if (named !== undefined) url.searchParams.set('visitorId', named);
  return GET(new NextRequest(url, { headers: cookie === null ? {} : { cookie: 'bubaly_vid=' + encodeURIComponent(cookie) } }));
};
const post = (cookie: string | null = OWN, value: unknown = { slug: 'family-day' }, raw?: string, extra: Record<string, string> = {}) => POST(new NextRequest('https://synthetic.invalid/api/blog/like', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(cookie === null ? {} : { cookie: 'bubaly_vid=' + encodeURIComponent(cookie) }), ...extra }, body: raw ?? JSON.stringify(value),
}));
const postReads = () => h.reads.filter(x => x.table === 'blog_posts');
const heartReads = () => h.reads.filter(x => x.table === 'blog_post_likes');
function noPostOrHeartWork() { expect(h.reads).toEqual([]); expect(h.writes).toEqual([]); }
beforeEach(() => {
  h.lookupData = { id: 'published-post' }; h.lookupError = null; h.likes = [{ post_id: 'published-post', visitor_id: FOREIGN }];
  h.reads = []; h.writes = []; h.rateAllowed = true; h.rate.mockClear(); h.ip.mockClear(); h.services.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { expect(h.forbidden).toEqual([]); vi.restoreAllMocks(); });

describe('legacy blog likes keep post lookup uncertainty separate from absence', () => {
  for (const method of ['GET', 'POST'] as const) for (const partial of [false, true]) {
    it(method + ' returned lookup error with ' + (partial ? 'partial data' : 'null data') + ' is unavailable before heart work', async () => {
      h.lookupData = partial ? { id: 'published-post' } : null; h.lookupError = { message: 'Synthetic lookup unavailable' };
      const response = await (method === 'GET' ? get() : post());
      expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'like.couldNotRecordTheLike' });
      expect(postReads()).toEqual([{ table: 'blog_posts', aggregate: false, filters: { slug: 'family-day', published: true } }]);
      expect(heartReads()).toEqual([]); expect(h.writes).toEqual([]);
      expect(h.rate).toHaveBeenCalledTimes(method === 'POST' ? 1 : 0); expect(h.ip).toHaveBeenCalledTimes(method === 'POST' ? 1 : 0);
      expect(console.error).toHaveBeenCalledWith('[blog] post lookup failed', { slug: 'family-day', error: 'Synthetic lookup unavailable' });
    });
  }
  for (const method of ['GET', 'POST'] as const) {
    it(method + ' confirmed absent or unpublished post remains not found without heart work', async () => {
      h.lookupData = null;
      const response = await (method === 'GET' ? get() : post());
      expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'like.notFound' });
      expect(postReads()).toHaveLength(1); expect(heartReads()).toEqual([]); expect(h.writes).toEqual([]); expect(console.error).not.toHaveBeenCalled();
    });
  }
  it('a visitor-less GET retains only the public count', async () => {
    const response = await get(null); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ count: 1, liked: false });
    expect(heartReads()).toEqual([{ table: 'blog_post_likes', aggregate: true, filters: { post_id: 'published-post' } }]); expect(h.writes).toEqual([]);
  });
  it('a bound browser reads only its own heart plus the public count', async () => {
    h.likes.push({ post_id: 'published-post', visitor_id: OWN });
    const response = await get(); expect(await response.json()).toEqual({ count: 2, liked: true });
    expect(heartReads().filter(x => !x.aggregate)).toEqual([{ table: 'blog_post_likes', aggregate: false, filters: { post_id: 'published-post', visitor_id: OWN } }]); expect(h.writes).toEqual([]);
  });
  it('a cached GET naming its own cookie is still served', async () => { const response = await get(OWN, 'family-day', OWN); expect(response.status).toBe(200); expect(await response.json()).toEqual({ count: 1, liked: false }); });
  it('the cookie-bound healthy toggle inserts and then removes only that same heart', async () => {
    const first = await post(); expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('no-store'); expect(await first.json()).toEqual({ count: 2, liked: true });
    const second = await post(); expect(second.status).toBe(200); expect(await second.json()).toEqual({ count: 1, liked: false });
    expect(h.likes).toEqual([{ post_id: 'published-post', visitor_id: FOREIGN }]);
    expect(h.writes).toEqual([{ op: 'insert', filters: { post_id: 'published-post', visitor_id: OWN } }, { op: 'insert', filters: { post_id: 'published-post', visitor_id: OWN } }, { op: 'delete', filters: { post_id: 'published-post', visitor_id: OWN } }]);
    // Duplicate insert is an in-memory uniqueness response, not real database concurrency evidence.
  });
  it('a cached POST naming the same cookie keeps cookie ownership', async () => { const response = await post(OWN, { slug: 'family-day', visitorId: OWN }); expect(response.status).toBe(200); expect(h.writes[0].filters.visitor_id).toBe(OWN); });
  for (const cookie of [OWN, null]) {
    it('GET refuses a foreign named id ' + (cookie ? 'with an own cookie' : 'without a cookie') + ' before any post or heart access', async () => {
      const response = await get(cookie, 'family-day', FOREIGN); expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'like.notThisVisitor' }); noPostOrHeartWork(); expect(h.services).not.toHaveBeenCalled(); expect(h.rate).not.toHaveBeenCalled();
    });
    it('POST refuses a foreign named id ' + (cookie ? 'with an own cookie' : 'without a cookie') + ' after throttling but before post or heart access', async () => {
      const response = await post(cookie, { slug: 'family-day', visitorId: FOREIGN }); expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'like.notThisVisitor' }); noPostOrHeartWork(); expect(h.rate).toHaveBeenCalledTimes(1); expect(h.ip).toHaveBeenCalledTimes(1);
    });
  }
  it('a non-string named visitor is refused before post or heart access', async () => { const response = await post(OWN, { slug: 'family-day', visitorId: 42 }); expect(response.status).toBe(403); noPostOrHeartWork(); });
  for (const cookie of [null, 'short', 'bad visitor id', 'x'.repeat(101)]) {
    it('POST requires a usable carried cookie: ' + (cookie === null ? 'missing' : cookie.length > 100 ? 'overlong' : cookie.includes(' ') ? 'invalid characters' : 'short'), async () => {
      const response = await post(cookie); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'like.visitorCookieRequired' }); noPostOrHeartWork(); expect(h.rate).toHaveBeenCalledTimes(1);
    });
  }
  it('an invalid carried cookie on GET still has public count and no private heart', async () => { const response = await get('bad visitor id'); expect(response.status).toBe(200); expect(await response.json()).toEqual({ count: 1, liked: false }); expect(heartReads().every(x => x.aggregate)).toBe(true); });
  it('the existing IP rate refusal precedes body and all post or heart access', async () => { h.rateAllowed = false; const response = await post(OWN, null, '{'); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('30'); noPostOrHeartWork(); expect(h.ip).toHaveBeenCalledTimes(1); });
  it('invalid JSON remains bad payload before post or heart access', async () => { const response = await post(OWN, null, '{'); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'Bad payload' }); noPostOrHeartWork(); });
  for (const mode of ['declared', 'streamed'] as const) {
    it(mode + ' body over the existing 2048-byte bound is refused before post or heart access', async () => {
      const response = mode === 'declared' ? await post(OWN, { slug: 'family-day' }, undefined, { 'content-length': '2049' }) : await post(OWN, { slug: 'family-day', padding: 'x'.repeat(2200) });
      expect(response.status).toBe(413); expect(await response.json()).toEqual({ error: 'Request body too large.' }); noPostOrHeartWork();
    });
  }
  for (const method of ['GET', 'POST'] as const) for (const slug of ['', 'Invalid Slug']) {
    it(method + ' invalid slug ' + JSON.stringify(slug) + ' is refused before post or heart access', async () => { const response = await (method === 'GET' ? get(OWN, slug) : post(OWN, { slug })); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'like.invalidSlug' }); noPostOrHeartWork(); });
  }
  for (const body of [null, []]) {
    it('non-record payload ' + JSON.stringify(body) + ' cannot choose a post or heart', async () => { const response = await post(OWN, body); expect(response.status).toBe(400); noPostOrHeartWork(); });
  }
  for (const method of ['GET', 'POST'] as const) {
    it(method + ' keeps existing slug trimming before published lookup', async () => { const response = await (method === 'GET' ? get(OWN, ' family-day ') : post(OWN, { slug: ' family-day ' })); expect(response.status).toBe(200); expect(postReads()[0].filters).toEqual({ slug: 'family-day', published: true }); });
  }
  it('an omitted or null named id never replaces the cookie owner', async () => { const response = await post(OWN, { slug: 'family-day', visitorId: null }); expect(response.status).toBe(200); expect(h.writes[0].filters.visitor_id).toBe(OWN); });
});
