import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

type Mode = 'healthy' | 'error' | 'hold' | 'body' | 'token' | 'constructor';
type CacheValue = { data: { body: string }; revalidate: number };
const state = vi.hoisted(() => ({
  mode: 'healthy' as Mode,
  rows: undefined as unknown,
  requests: [] as { url: URL; signal?: AbortSignal | null }[],
  releases: [] as (() => void)[],
  entries: new Map<string, { value: CacheValue; at: number }>(),
  writes: [] as CacheValue[],
  run: undefined as undefined | (<T>(fn: () => Promise<T>) => Promise<T>),
  makeClient: undefined as undefined | (() => ReturnType<typeof createClient>),
}));

// Exercise the installed Next cache algorithm. Only its persistence adapter is
// in memory; unlike an identity mock, a successful fallback is actually cached.
vi.mock('next/cache', async () => {
  const { createRequire } = await import('node:module');
  const { AsyncLocalStorage } = await import('node:async_hooks');
  Object.defineProperty(globalThis, 'AsyncLocalStorage', { value: AsyncLocalStorage, configurable: true });
  const require = createRequire(import.meta.url);
  const { unstable_cache } = require('next/dist/server/web/spec-extension/unstable-cache');
  const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external') as {
    workAsyncStorage: { run<T>(store: object, fn: () => T): T };
  };
  state.run = async <T,>(fn: () => Promise<T>) => {
    const store = {
      route: '/', page: '/',
      isStaticGeneration: false, isDraftMode: false, nextFetchId: 1,
      pendingRevalidates: {} as Record<string, Promise<unknown>>,
      incrementalCache: {
        async generateSimpleCacheKey(key: string) { return key; },
        async get(key: string) {
          const entry = state.entries.get(key);
          return entry ? { value: entry.value, isStale: Date.now() - entry.at >= entry.value.revalidate * 1000 } : null;
        },
        async set(key: string, value: CacheValue) {
          state.entries.set(key, { value, at: Date.now() });
          state.writes.push(value);
        },
      },
    };
    const result = await workAsyncStorage.run(store, fn);
    await Promise.all(Object.values(store.pendingRevalidates));
    return result;
  };
  return { unstable_cache };
});
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.makeClient!() }));
import { getPublishedTestimonials } from '@/lib/marketing/reputation-server';

const quote = {
  id: 'first', author_name: 'Synthetic author', author_role: null, company: null,
  quote: 'Synthetic published quote', rating: 4, is_published: true, sort_order: 2,
};
async function hold() { await new Promise<void>(resolve => state.releases.push(resolve)); }
async function transport(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  expect(url.origin).toBe('https://testimonials-audit.invalid');
  expect(url.pathname).toBe('/rest/v1/testimonials');
  state.requests.push({ url, signal: init?.signal });
  if (state.mode === 'hold') await hold(); // Deliberately ignore abort.
  if (state.mode === 'error') return Response.json({ message: 'Synthetic unavailable' }, { status: 503 });
  const response = Response.json(state.rows);
  if (state.mode === 'body') {
    const text = response.text.bind(response);
    response.text = async () => { await hold(); return text(); };
  }
  return response;
}
async function run() {
  const pending = state.run!(getPublishedTestimonials);
  await vi.advanceTimersByTimeAsync(8_000);
  return pending;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', () => { throw new Error('Real network forbidden by fixture'); });
  state.mode = 'healthy'; state.rows = [quote]; state.requests = []; state.releases = [];
  state.entries.clear(); state.writes = [];
  state.makeClient = () => {
    if (state.mode === 'constructor') throw new Error('Synthetic client unavailable');
    return createClient('https://testimonials-audit.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport },
      ...(state.mode === 'token' ? { accessToken: async () => { await hold(); return 'synthetic-token'; } } : {}),
    });
  };
});
afterEach(async () => {
  state.releases.splice(0).forEach(release => release());
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('testimonials cache only verified successful reads', () => {
  it('preserves publication filtering, sort order, selected fields and six-row query cap', async () => {
    state.rows = [quote, { ...quote, id: 'hidden', is_published: false }, { ...quote, id: 'earlier', sort_order: 1 }];
    const rows = await run();
    expect(rows.map(row => row.id)).toEqual(['earlier', 'first']);
    expect(rows[0]).toEqual({ id: 'earlier', authorName: quote.author_name, authorRole: null, company: null, quote: quote.quote, rating: 4 });
    const query = state.requests[0].url.searchParams;
    expect(query.get('is_published')).toBe('eq.true');
    expect(query.get('order')).toBe('sort_order.asc');
    expect(query.get('limit')).toBe('6');
    expect(query.get('select')).toBe('id,author_name,author_role,company,quote,rating,is_published,sort_order');
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].revalidate).toBe(3600);
  });

  it.each([[null, null], [-1, 1], [0, 1], [1, 1], [2.4, 2], [2.6, 3], [5, 5], [8, 5]])('preserves rating %j as %j', async (rating, expected) => {
    state.rows = [{ ...quote, rating }];
    expect((await run())[0].rating).toBe(expected);
    expect(state.writes).toHaveLength(1);
  });

  it('caches a genuinely empty list and does not substitute later quotes within the freshness window', async () => {
    state.rows = [];
    expect(await run()).toEqual([]);
    state.rows = [quote];
    expect(await run()).toEqual([]);
    expect(state.requests).toHaveLength(1);
    expect(state.writes).toHaveLength(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(['error', 'constructor'] as const)('does not cache %s as a successful empty list', async mode => {
    state.mode = mode;
    expect(await run()).toEqual([]);
    expect(state.writes).toHaveLength(0);
    state.mode = 'healthy';
    expect((await run()).map(row => row.id)).toEqual(['first']);
  });

  it('preserves last-good quotes when a stale refresh fails and retries a later healthy refresh', async () => {
    const first = await run();
    vi.setSystemTime(Date.now() + 3_600_001);
    state.mode = 'error';
    expect(await run()).toEqual(first);
    expect(state.writes).toHaveLength(1);
    state.mode = 'healthy'; state.rows = [{ ...quote, id: 'updated' }];
    expect(await run()).toEqual(first); // Stale-while-revalidate response.
    expect((await run()).map(row => row.id)).toEqual(['updated']);
  });

  it.each([
    null, {}, [null], [{}], [false], [[]],
    [{ ...quote, author_name: {} }], [{ ...quote, author_role: 7 }],
    [{ ...quote, company: [] }], [{ ...quote, quote: false }],
    [{ ...quote, rating: '5' }], [{ ...quote, is_published: 'true' }],
    [{ ...quote, sort_order: '1' }], [{ ...quote, id: 7 }],
  ].map(rows => ({ rows })))('rejects malformed successful payload $rows before cache admission', async ({ rows }) => {
    state.rows = rows;
    expect(await run()).toEqual([]);
    expect(state.writes).toHaveLength(0);
    state.rows = [quote];
    expect((await run()).map(row => row.id)).toEqual(['first']);
  });
});

describe('testimonial SDK reads use the existing four-second callback budget', () => {
  it.each(['hold', 'body', 'token'] as const)('bounds %s waiting without admitting a late quote to cache', async mode => {
    state.mode = mode;
    let settled = false;
    const pending = state.run!(getPublishedTestimonials).then(rows => { settled = true; return rows; });
    try {
      await vi.advanceTimersByTimeAsync(3_999); expect(settled).toBe(false);
      if (mode === 'token') expect(state.requests).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2); expect(settled).toBe(true);
      expect(await pending).toEqual([]); expect(state.writes).toHaveLength(0);
      state.releases.splice(0).forEach(release => release());
      await vi.advanceTimersByTimeAsync(0);
      expect(state.requests.every(request => request.signal?.aborted)).toBe(true);
      expect(state.writes).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
      state.mode = 'healthy';
      expect((await run()).map(row => row.id)).toEqual(['first']);
    } finally {
      state.releases.splice(0).forEach(release => release());
      await vi.advanceTimersByTimeAsync(8_000); await pending;
    }
  });

  it('stops SDK retry attempts after the budget without changing retry configuration', async () => {
    state.mode = 'error';
    let settled = false;
    const pending = state.run!(getPublishedTestimonials).then(rows => { settled = true; return rows; });
    try {
      await vi.advanceTimersByTimeAsync(4_001); expect(settled).toBe(true);
      expect(await pending).toEqual([]);
      const attempts = state.requests.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.requests).toHaveLength(attempts);
      expect(state.writes).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    } finally { await vi.advanceTimersByTimeAsync(8_000); await pending; }
  });
});
