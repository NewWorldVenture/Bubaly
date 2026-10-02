import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createClient as realCreateClient } from '@supabase/supabase-js';

type Kind = 'accounts' | 'handled' | 'studies';
type Mode = 'healthy' | 'zero' | 'error' | 'invalid' | 'hold' | 'hold-body' | 'null' | 'object';
type CacheValue = { data: { body: string }; revalidate: number };
const state = vi.hoisted(() => ({
  modes: {} as Partial<Record<Kind, Mode>>,
  requests: [] as { kind: Kind; signal?: AbortSignal | null }[],
  releases: [] as (() => void)[],
  entries: new Map<string, { value: CacheValue; at: number }>(),
  writes: [] as CacheValue[],
  run: undefined as undefined | (<T>(fn: () => Promise<T>) => Promise<T>),
  makeClient: undefined as undefined | (() => ReturnType<typeof realCreateClient>),
  studyRows: undefined as unknown[] | undefined,
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
      route: '/pricing', page: '/pricing', forceDynamic: true,
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
vi.mock('@supabase/supabase-js', async (original) => {
  const actual = await original<typeof import('@supabase/supabase-js')>();
  return { ...actual, createClient: () => state.makeClient!() };
});

import { getPublicStats } from '@/lib/marketing/stats';
import { getPublishedCaseStudies } from '@/lib/marketing/reputation-server';

const accounts = { families: 40, members: 100, tasks_completed: 150 };
const handled = { runs_completed: 80, runs_completed_30d: 30, families_with_runs: 20 };
const study = { id: 'published', slug: 'family-story', title: 'Fixture story', customer_name: null, summary: null, result_metric: null, verified_at: null, is_published: true };

async function held() { await new Promise<void>(resolve => state.releases.push(resolve)); }
async function fetchFixture(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  expect(url.origin).toBe('https://pricing-audit.invalid');
  const kinds: Record<string, Kind> = {
    '/rest/v1/rpc/public_stats': 'accounts',
    '/rest/v1/rpc/public_handled_stats': 'handled',
    '/rest/v1/case_studies': 'studies',
  };
  const kind = kinds[url.pathname];
  if (!kind) throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
  state.requests.push({ kind, signal: init?.signal });
  const mode = state.modes[kind] ?? 'healthy';
  // Deliberately ignore abort so the caller's own deadline is load-bearing.
  if (mode === 'hold') await held();
  if (mode === 'error') return Response.json({ message: 'Synthetic outage' }, { status: 503 });
  let rows: unknown;
  if (kind === 'accounts') rows = [mode === 'zero' ? { families: 0, members: 0, tasks_completed: 0 } : mode === 'invalid' ? { ...accounts, families: -1 } : accounts];
  if (kind === 'handled') rows = [mode === 'zero' ? { runs_completed: 0, runs_completed_30d: 0, families_with_runs: 0 } : handled];
  if (kind === 'studies') rows = mode === 'zero' ? [] : mode === 'null' ? null : mode === 'object' ? {} : state.studyRows ?? [study, { ...study, id: 'seed', slug: 'seed-case_studies-450' }, { ...study, id: 'hidden', is_published: false }];
  const response = Response.json(rows);
  if (mode === 'hold-body') {
    const text = response.text.bind(response);
    response.text = async () => { await held(); return text(); };
  }
  return response;
}

async function run<T>(fn: () => Promise<T>) {
  const result = state.run!(fn);
  await vi.advanceTimersByTimeAsync(8_000); // Includes unmodified SDK retry backoff.
  return result;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', () => { throw new Error('Real network is forbidden by this fixture'); });
  state.modes = {}; state.requests = []; state.releases = []; state.writes = []; state.entries.clear();
  state.studyRows = undefined;
  // importActual keeps the anonymous-client seam synthetic while using the
  // installed query builder, retry/response parsing and cancellation handling.
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
  state.makeClient = () => actual.createClient('https://pricing-audit.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchFixture },
  });
});
afterEach(async () => {
  state.releases.splice(0).forEach(release => release());
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('optional public data does not turn an outage into cached evidence', () => {
  it.each(['accounts', 'handled'] as const)('does not cache the failing %s group and preserves its healthy peer', async kind => {
    state.modes[kind] = 'error';
    const failed = await run(getPublicStats);
    expect(failed.families).toBe(kind === 'accounts' ? 0 : 40);
    expect(failed.handledCompleted).toBe(kind === 'handled' ? 0 : 80);
    const peerReads = state.requests.filter(r => r.kind !== kind).length;
    state.modes = {};
    const healthy = await run(getPublicStats);
    expect(healthy.families).toBe(40); expect(healthy.handledCompleted).toBe(80);
    expect(state.requests.filter(r => r.kind !== kind)).toHaveLength(peerReads);
    expect(state.requests.filter(r => r.kind === kind)).toHaveLength(2);
  });

  it('does not cache a malformed aggregate as a valid zero', async () => {
    state.modes.accounts = 'invalid';
    expect((await run(getPublicStats)).families).toBe(0);
    state.modes.accounts = 'healthy';
    expect((await run(getPublicStats)).families).toBe(40);
  });

  it('does not cache a failed study list as a legitimately empty one', async () => {
    state.modes.studies = 'error';
    expect(await run(getPublishedCaseStudies)).toEqual([]);
    expect(state.writes).toHaveLength(0);
    state.modes.studies = 'healthy';
    expect((await run(getPublishedCaseStudies)).map(row => row.id)).toEqual(['published']);
  });

  it.each(['null', 'object'] as const)('does not cache malformed successful study payload %s as empty', async mode => {
    state.modes.studies = mode;
    expect(await run(getPublishedCaseStudies)).toEqual([]);
    expect(state.writes).toHaveLength(0);
    state.modes.studies = 'healthy';
    expect((await run(getPublishedCaseStudies)).map(row => row.id)).toEqual(['published']);
  });

  it.each([
    {}, false, null, [],
    { ...study, title: { invalid: true } },
    { ...study, id: 7 },
    { ...study, slug: null },
    { ...study, customer_name: 7 },
    { ...study, summary: [] },
    { ...study, result_metric: {} },
    { ...study, is_published: 'true' },
    { ...study, verified_at: true },
  ])('rejects malformed study row %j before it can become cached publication data', async row => {
    state.studyRows = [row];
    expect(await run(getPublishedCaseStudies)).toEqual([]);
    expect(state.writes).toHaveLength(0);
    state.studyRows = undefined;
    expect((await run(getPublishedCaseStudies)).map(item => item.id)).toEqual(['published']);
  });

  it('preserves pre-migration records without verified_at and verified strings', async () => {
    const { verified_at: _legacy, ...legacy } = study;
    state.studyRows = [legacy, { ...study, id: 'verified', verified_at: '2026-09-30T12:00:00Z' }];
    expect((await run(getPublishedCaseStudies)).map(item => item.verifiedAt)).toEqual([null, '2026-09-30T12:00:00Z']);
    expect(state.writes).toHaveLength(1);
  });

  it.each(['stats', 'studies'] as const)('keeps a validated zero/empty %s result cacheable', async kind => {
    state.modes = { accounts: 'zero', handled: 'zero', studies: 'zero' };
    const read = kind === 'stats' ? getPublicStats : getPublishedCaseStudies;
    const first = await run(read as () => Promise<unknown>);
    const requestCount = state.requests.length;
    state.modes = {};
    expect(await run(read as () => Promise<unknown>)).toEqual(first);
    expect(state.requests).toHaveLength(requestCount);
    expect(state.writes.every(entry => entry.revalidate === 3600)).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(['stats', 'studies'] as const)('keeps last-good %s when its stale refresh fails', async kind => {
    const read = kind === 'stats' ? getPublicStats : getPublishedCaseStudies;
    const first = await run(read as () => Promise<unknown>);
    const writes = state.writes.length;
    vi.setSystemTime(Date.now() + 3_600_001);
    state.modes = kind === 'stats' ? { accounts: 'error', handled: 'error' } : { studies: 'error' };
    expect(await run(read as () => Promise<unknown>)).toEqual(first);
    expect(state.writes).toHaveLength(writes);
    state.modes = {};
    expect(await run(read as () => Promise<unknown>)).toEqual(first);
  });
});

describe('optional SDK reads have one four-second caller budget', () => {
  it.each(['accounts', 'handled', 'studies'] as const)('settles a held %s fetch even when transport ignores abort', async kind => {
    state.modes[kind] = 'hold';
    const read = kind === 'studies' ? getPublishedCaseStudies : getPublicStats;
    let settled = false;
    const pending = state.run!(read as () => Promise<unknown>).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(state.requests.some(request => request.kind === kind)).toBe(true);
      await vi.advanceTimersByTimeAsync(3_999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2); expect(settled).toBe(true);
      expect(state.requests.find(request => request.kind === kind)?.signal?.aborted).toBe(true);
      const written = state.writes.length;
      state.releases.splice(0).forEach(release => release());
      await vi.advanceTimersByTimeAsync(0); await pending;
      expect(state.writes).toHaveLength(written); // Late success is not the timed-out cached result.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      state.releases.splice(0).forEach(release => release());
      await pending;
    }
  });

  it('includes response body parsing in the budget', async () => {
    state.modes.studies = 'hold-body';
    let settled = false;
    const pending = state.run!(getPublishedCaseStudies).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(4_001);
      expect(settled).toBe(true); expect(await pending).toEqual([]);
      expect(state.writes).toHaveLength(0);
      state.releases.splice(0).forEach(release => release());
      await vi.advanceTimersByTimeAsync(0);
      expect(state.writes).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    } finally { state.releases.splice(0).forEach(release => release()); await pending; }
  });
});
