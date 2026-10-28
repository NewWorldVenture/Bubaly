import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type AuthError = { name?: string; status?: number; code?: string; message?: string };
type Read = { table: string; op: string; filters: Record<string, unknown>; aggregate: boolean };
const h = vi.hoisted(() => ({ user: { id: 'reader-a' } as { id: string } | null, error: null as AuthError | null,
  reads: [] as Read[], writes: [] as Read[], saved: true, published: true, postLookupError: null as { code: string; message: string } | null, postLookupPartial: false, insertError: null as { code: string } | null,
  deleteError: null as { code: string } | null, readError: false, rateAllowed: true, rate: vi.fn(), ip: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/rate-limit', () => ({ clientIp: () => { h.ip(); return 'synthetic-ip'; } }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => { h.rate(); return { ok: h.rateAllowed, retryAfter: 30 }; } }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ auth: { getUser: async () => ({ data: { user: h.user }, error: h.error }) } }),
  createServiceClient: () => ({ from: (table: string) => {
    const state: Read = { table, op: 'select', filters: {}, aggregate: false };
    const result = () => {
      const copy = { ...state, filters: { ...state.filters } };
      if (state.op === 'select') h.reads.push(copy); else h.writes.push(copy);
      if (table === 'blog_posts') return { data: h.postLookupError ? (h.postLookupPartial ? { id: 'published-post' } : null) : h.published ? { id: 'published-post' } : null, error: h.postLookupError };
      if (table !== 'blog_post_saves') throw new Error('Unexpected synthetic table');
      if (state.op === 'insert') return { data: null, error: h.insertError };
      if (state.op === 'delete') return { data: null, error: h.deleteError };
      return { data: state.aggregate ? null : h.saved ? { id: 'own-bookmark' } : null, count: 7, error: h.readError ? { code: 'SYNTHETIC_READ' } : null };
    };
    const q = {
      select: (_fields: string, options?: { count?: string; head?: boolean }) => { state.aggregate = !!options?.count; return q; },
      eq: (key: string, value: unknown) => { state.filters[key] = value; return q; },
      insert: (row: Record<string, unknown>) => { state.op = 'insert'; state.filters = { ...row }; return q; },
      delete: () => { state.op = 'delete'; return q; },
      maybeSingle: async () => result(),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve().then(result).then(resolve, reject),
    };
    return q;
  } }),
}));
const { GET, POST } = await import('@/app/api/blog/save/route');
const get = (slug = 'family-day') => GET(new NextRequest('https://synthetic.invalid/api/blog/save?slug=' + encodeURIComponent(slug)));
const post = (body = JSON.stringify({ slug: 'family-day' })) => POST(new NextRequest('https://synthetic.invalid/api/blog/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
const privateReads = () => h.reads.filter(x => x.table === 'blog_post_saves' && !x.aggregate);
const publicReads = () => h.reads.filter(x => x.table === 'blog_posts' || x.aggregate);
beforeEach(() => {
  h.user = { id: 'reader-a' }; h.error = null; h.reads = []; h.writes = []; h.saved = true; h.published = true;
  h.postLookupError = null; h.postLookupPartial = false; h.insertError = null; h.deleteError = null; h.readError = false; h.rateAllowed = true; h.rate.mockClear(); h.ip.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const transient = [
  { label: 'known 503', error: { name: 'AuthApiError', status: 503, message: 'Synthetic unavailable' } },
  { label: 'retryable fetch error', error: { name: 'AuthRetryableFetchError', message: 'Synthetic unavailable' } },
  { label: 'known network status zero', error: { name: 'AuthApiError', status: 0, message: 'Synthetic unavailable' } },
];
async function uncertain(method: 'GET' | 'POST') {
  const response = await (method === 'GET' ? get() : post());
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'save.couldNotRecordTheSave' });
  expect(privateReads()).toEqual([]); expect(h.writes).toEqual([]);
  expect(h.rate).not.toHaveBeenCalled(); expect(h.ip).not.toHaveBeenCalled();
  // GET may look up the published post; that public read is intentional.
  if (method === 'GET') expect(publicReads().some(x => x.table === 'blog_posts')).toBe(true);
}
describe('blog saves retain auth read uncertainty', () => {
  for (const sample of transient) for (const method of ['GET', 'POST'] as const) {
    it(method + ' ' + sample.label + ' with no user is unavailable, never signed out', async () => {
      h.user = null; h.error = sample.error; await uncertain(method);
    });
  }
  for (const method of ['GET', 'POST'] as const) {
    it(method + ' mixed stale user plus 503 is defense-only and refuses protected work', async () => {
      // Current SDK UserResponse excludes this mixed shape; no exploit claim.
      h.error = { name: 'AuthApiError', status: 503 }; await uncertain(method);
    });
  }
  for (const status of [401, 403]) for (const mixed of [false, true]) for (const method of ['GET', 'POST'] as const) {
    it(method + ' credential rejection ' + status + (mixed ? ' with hypothetical stale user' : ' with no user') + ' retains anonymous denial', async () => {
      if (!mixed) h.user = null;
      h.error = { name: 'AuthApiError', status, message: 'Synthetic credential rejection' };
      const response = await (method === 'GET' ? get() : post());
      expect(response.status).toBe(method === 'GET' ? 200 : 401);
      const body = await response.json(); expect(body.authenticated).toBe(false);
      if (method === 'GET') expect(body).toEqual({ saved: false, count: 7, authenticated: false });
      else expect(body.error).toBe('auth_required');
      expect(privateReads()).toEqual([]); expect(h.writes).toEqual([]); expect(h.rate).not.toHaveBeenCalled();
    });
  }
  for (const method of ['GET', 'POST'] as const) {
    it(method + ' confirmed anonymous keeps the existing public-read or denied-write behavior', async () => {
      h.user = null;
      const response = await (method === 'GET' ? get() : post());
      expect(response.status).toBe(method === 'GET' ? 200 : 401);
      expect((await response.json()).authenticated).toBe(false);
      expect(privateReads()).toEqual([]); expect(h.writes).toEqual([]); expect(h.rate).not.toHaveBeenCalled();
      if (method === 'GET') expect(publicReads().some(x => x.aggregate)).toBe(true);
    });
  }
  it('healthy GET reads only its authenticated reader bookmark and public aggregate', async () => {
    const response = await get(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true, count: 7, authenticated: true });
    expect(privateReads()).toEqual([{ table: 'blog_post_saves', op: 'select', aggregate: false, filters: { post_id: 'published-post', user_id: 'reader-a' } }]);
    expect(h.writes).toEqual([]); expect(h.rate).not.toHaveBeenCalled();
  });
  it('healthy POST saves for the server-authenticated reader only', async () => {
    const response = await post(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true, count: 7, authenticated: true });
    expect(h.writes).toEqual([{ table: 'blog_post_saves', op: 'insert', aggregate: false, filters: { post_id: 'published-post', user_id: 'reader-a' } }]);
    expect(h.rate).toHaveBeenCalledOnce();
  });
  it('an injected uniqueness refusal chooses the owned delete branch without claiming database concurrency', async () => {
    h.insertError = { code: '23505' };
    const response = await post(); expect(response.status).toBe(200); expect((await response.json()).saved).toBe(false);
    expect(h.writes.map(x => [x.op, x.filters.user_id])).toEqual([['insert', 'reader-a'], ['delete', 'reader-a']]);
    expect(h.writes.map(x => [x.op, x.filters.post_id])).toEqual([['insert', 'published-post'], ['delete', 'published-post']]);
  });
  it('invalid JSON still refuses before a toggle', async () => { const response = await post('{'); expect(response.status).toBe(400); expect(h.writes).toEqual([]); });
  it('an oversized payload still refuses before a toggle', async () => { const response = await post(JSON.stringify({ slug: 'x'.repeat(3000) })); expect(response.status).toBe(413); expect(h.writes).toEqual([]); });
  it('an empty GET slug remains invalid before any service read', async () => { const response = await get(''); expect(response.status).toBe(400); expect(h.reads).toEqual([]); });
  it('an unpublished or missing post remains unavailable as a public lookup', async () => { h.published = false; const response = await get(); expect(response.status).toBe(404); expect(privateReads()).toEqual([]); });
  it('a non-unique insert refusal is never reported as saved', async () => { h.insertError = { code: 'SYNTHETIC_REFUSAL' }; const response = await post(); expect(response.status).toBe(500); expect(h.writes.map(x => x.op)).toEqual(['insert']); });
  it('a failed owned delete is never reported as unsaved', async () => { h.insertError = { code: '23505' }; h.deleteError = { code: 'SYNTHETIC_REFUSAL' }; const response = await post(); expect(response.status).toBe(500); expect((await response.json()).saved).toBeUndefined(); });
  it('a refused healthy rate limit still avoids mutation', async () => { h.rateAllowed = false; const response = await post(); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('30'); expect(h.writes).toEqual([]); });
  it('a caller-supplied user id cannot choose the bookmark owner', async () => { await post(JSON.stringify({ slug: 'family-day', user_id: 'foreign-reader' })); expect(h.writes.every(x => x.filters.user_id === 'reader-a')).toBe(true); expect(h.writes).toHaveLength(1); });
  it('an unreadable healthy saved state retains existing unavailable semantics', async () => { h.readError = true; const response = await get(); expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store'); });
  it('the unchanged heart source retains state on non-OK GET and only treats POST401 as sign-in', () => {
    const source = readFileSync('components/blog/heart-button.tsx', 'utf8');
    expect(source).toContain('r.ok ? r.json() : null'); expect(source).toContain('if (cancelled || !d) return;'); expect(source).toContain('if (res.status === 401)');
    // This is source evidence, not a rendered three-state-heart or login-lifecycle claim.
  });
});


// Returned unknown wrappers cannot prove sign-out; mixed user/error is defensive only.
const unknownAuthRead = () => ({ name: 'AuthUnknownError', __isAuthError: true, status: undefined, code: undefined, message: 'Unexpected end of JSON input', originalError: { name: 'SyntaxError', message: 'Unexpected end of JSON input' } });
describe('blog saves keep unknown auth reads unavailable', () => {
  for (const staleUser of [false, true]) for (const method of ['GET', 'POST'] as const) {
    it(method + ' unknown read with ' + (staleUser ? 'hypothetical stale user' : 'no user') + ' never becomes signed out', async () => {
      if (!staleUser) h.user = null;
      h.error = unknownAuthRead();
      await uncertain(method);
    });
  }
});


// Literal returned lookup errors only; no transport rejection or post-write fault.
describe('blog save post lookup uncertainty is not a missing article', () => {
  for (const partial of [false, true]) for (const method of ['GET', 'POST'] as const) {
    it(method + ' returned published-post lookup error with ' + (partial ? 'partial data' : 'null data') + ' is unavailable before bookmark work', async () => {
      h.postLookupError = { code: 'SYNTHETIC_POST_LOOKUP', message: 'Synthetic post lookup unavailable' };
      h.postLookupPartial = partial;
      const response = await (method === 'GET' ? get() : post());
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'save.couldNotRecordTheSave' });
      expect(h.reads).toEqual([{ table: 'blog_posts', op: 'select', aggregate: false, filters: { slug: 'family-day', published: true } }]);
      expect(h.writes).toEqual([]);
      expect(privateReads()).toEqual([]);
    });
  }
  it('POST confirmed missing published post retains404 and does not write a bookmark', async () => {
    h.published = false;
    const response = await post();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'save.notFound' });
    expect(h.reads).toEqual([{ table: 'blog_posts', op: 'select', aggregate: false, filters: { slug: 'family-day', published: true } }]);
    expect(h.writes).toEqual([]);
  });
});
