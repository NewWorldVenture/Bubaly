import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Read = { table: string; aggregate: boolean; filters: Record<string, unknown> };
const h = vi.hoisted(() => ({
  count: 7 as number | null,
  countError: null as { code: string } | null,
  ownData: { id: 'own-heart' } as { id: string } | null,
  ownError: null as { code: string } | null,
  postData: { id: 'published-post' } as { id: string } | null,
  postError: null as { message: string } | null,
  reads: [] as Read[], forbidden: [] as string[], services: vi.fn(),
}));
function refuse(name: string): never { h.forbidden.push(name); throw Error('Forbidden GET-only model: ' + name); }
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/rate-limit', () => ({ clientIp: () => refuse('GET rate IP') }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: () => refuse('GET rate mutation') }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: () => refuse('Auth server'),
  createServiceClient: () => {
    h.services();
    return { from: (table: string) => {
      if (!['blog_posts', 'blog_post_likes'].includes(table)) return refuse('table ' + table);
      const state = { aggregate: false, filters: {} as Record<string, unknown> };
      const terminal = () => {
        h.reads.push({ table, aggregate: state.aggregate, filters: { ...state.filters } });
        if (table === 'blog_posts') {
          if (state.aggregate || state.filters.slug !== 'family-day' || state.filters.published !== true) return refuse('published post predicate');
          return { data: h.postData, error: h.postError };
        }
        if (state.filters.post_id !== 'published-post') return refuse('post-bound heart read');
        if (state.aggregate) {
          if (Object.keys(state.filters).length !== 1) return refuse('aggregate scope');
          return { data: null, count: h.count, error: h.countError };
        }
        if (state.filters.visitor_id !== 'visitor-own-0001' || Object.keys(state.filters).length !== 2) return refuse('own visitor scope');
        return { data: h.ownData, error: h.ownError };
      };
      const q = {
        select: (fields: string, options?: { count?: string; head?: boolean }) => {
          if (fields !== 'id') return refuse('unexpected projection');
          if (options && (options.count !== 'exact' || options.head !== true)) return refuse('aggregate options');
          state.aggregate = !!options; return q;
        },
        eq: (key: string, value: unknown) => { if (key in state.filters) return refuse('duplicate predicate'); state.filters[key] = value; return q; },
        insert: () => refuse('insert'), delete: () => refuse('delete'), update: () => refuse('update'), upsert: () => refuse('upsert'),
        maybeSingle: async () => terminal(),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve().then(terminal).then(resolve, reject),
      };
      return q;
    } };
  },
}));
const { GET } = await import('@/app/api/blog/like/route');
const OWN = 'visitor-own-0001', FOREIGN = 'visitor-other-0002';
function get(cookie: string | null = OWN, named?: string, slug = 'family-day') {
  const url = new URL('https://synthetic.invalid/api/blog/like'); url.searchParams.set('slug', slug);
  if (named !== undefined) url.searchParams.set('visitorId', named);
  return GET(new NextRequest(url, { headers: cookie === null ? {} : { cookie: 'bubaly_vid=' + encodeURIComponent(cookie) } }));
}
const heartReads = () => h.reads.filter(x => x.table === 'blog_post_likes');
function scope(own: boolean) {
  expect(h.reads[0]).toEqual({ table: 'blog_posts', aggregate: false, filters: { slug: 'family-day', published: true } });
  expect(heartReads()).toEqual([
    { table: 'blog_post_likes', aggregate: true, filters: { post_id: 'published-post' } },
    ...(own ? [{ table: 'blog_post_likes', aggregate: false, filters: { post_id: 'published-post', visitor_id: OWN } }] : []),
  ]);
}
async function unavailable(cookie: string | null = OWN) {
  const response = await get(cookie);
  expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'like.couldNotRecordTheLike' }); scope(cookie !== null);
}
beforeEach(() => {
  h.count = 7; h.countError = null; h.ownData = { id: 'own-heart' }; h.ownError = null;
  h.postData = { id: 'published-post' }; h.postError = null; h.reads = []; h.services.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { expect(h.forbidden).toEqual([]); vi.restoreAllMocks(); });

describe('blog like GET preserves heart-read uncertainty without writes', () => {
  for (const partial of [false, true]) {
    it('count read error with ' + (partial ? 'partial count' : 'null count') + ' returns unavailable', async () => {
      h.count = partial ? 7 : null; h.countError = { code: 'SYNTHETIC_COUNT_READ' }; await unavailable();
    });
    it('own-row read error with ' + (partial ? 'partial row' : 'null row') + ' returns unavailable', async () => {
      h.ownData = partial ? { id: 'own-heart' } : null; h.ownError = { code: 'SYNTHETIC_OWN_READ' }; await unavailable();
    });
  }
  it('both returned read errors cannot fabricate empty heart state', async () => {
    h.count = null; h.countError = { code: 'SYNTHETIC_COUNT_READ' }; h.ownData = null; h.ownError = { code: 'SYNTHETIC_OWN_READ' }; await unavailable();
  });
  it('visitor-less count failure is unavailable without a personal read', async () => {
    h.count = null; h.countError = { code: 'SYNTHETIC_COUNT_READ' }; await unavailable(null);
  });
  it('healthy own heart and public count remain successful', async () => {
    const response = await get(); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ count: 7, liked: true }); scope(true);
  });
  it('confirmed empty own row retains the independently returned public count', async () => {
    h.ownData = null; const response = await get(); expect(response.status).toBe(200); expect(await response.json()).toEqual({ count: 7, liked: false }); scope(true);
  });
  it('confirmed empty count and own row remain zero and false', async () => {
    h.count = 0; h.ownData = null; const response = await get(); expect(response.status).toBe(200); expect(await response.json()).toEqual({ count: 0, liked: false }); scope(true);
  });
  it('healthy null count preserves the established zero fallback', async () => {
    h.count = null; h.ownData = null; const response = await get(); expect(response.status).toBe(200); expect(await response.json()).toEqual({ count: 0, liked: false }); scope(true);
  });
  for (const cookie of [null, 'bad visitor id']) {
    it((cookie === null ? 'missing' : 'invalid') + ' carried cookie reads only public count', async () => {
      h.ownError = { code: 'UNUSED_OWN_ERROR' }; const response = await get(cookie); expect(response.status).toBe(200); expect(await response.json()).toEqual({ count: 7, liked: false }); scope(false);
    });
  }
  it('matching explicit visitor cannot change cookie scope', async () => {
    const response = await get(OWN, OWN); expect(response.status).toBe(200); expect(await response.json()).toEqual({ count: 7, liked: true }); scope(true);
  });
  for (const cookie of [OWN, null]) {
    it('foreign named visitor is refused ' + (cookie ? 'with own cookie' : 'without cookie') + ' before reads', async () => {
      const response = await get(cookie, FOREIGN); expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'like.notThisVisitor' });
      expect(h.reads).toEqual([]); expect(h.services).not.toHaveBeenCalled();
    });
  }
  it('confirmed missing post retains404 without heart reads', async () => {
    h.postData = null; const response = await get(); expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'like.notFound' }); expect(heartReads()).toEqual([]);
  });
  it('post lookup error remains unavailable before heart reads', async () => {
    h.postError = { message: 'Synthetic post error' }; const response = await get(); expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'like.couldNotRecordTheLike' }); expect(heartReads()).toEqual([]);
  });
  it('invalid slug is refused before any service read', async () => {
    const response = await get(OWN, undefined, 'Invalid Slug'); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'like.invalidSlug' });
    expect(h.reads).toEqual([]); expect(h.services).not.toHaveBeenCalled();
  });
});
