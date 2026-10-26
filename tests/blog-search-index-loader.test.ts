import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSearchIndexLoader, SEARCH_INDEX_MAX_ATTEMPTS, SEARCH_INDEX_RETRY_AFTER_MS, type SearchIndexState,
} from '@/lib/blog/search-index-loader';

// Review 5372934636 on #709: when the index cannot be loaded, the typeahead
// must say so and be able to try again, in bounded steps, instead of treating
// the outage as "no articles" for the rest of the mount.
type Post = { slug: string; title: string; excerpt: string; category: string };
const POST: Post = { slug: 'a', title: 'A', excerpt: 'x', category: 'Parenting' };

function harness(replies: Array<() => Promise<Response>>) {
  let clock = 0;
  const states: SearchIndexState[] = [];
  let posts: Post[] = [];
  const fetchIndex = vi.fn((_signal?: AbortSignal) => {
    const next = replies.shift();
    if (!next) throw new Error('unexpected extra request');
    return next();
  });
  const loader = createSearchIndexLoader<Post>({
    fetchIndex,
    now: () => clock,
    onChange: (state, loaded) => { states.push(state); posts = loaded; },
  });
  const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  return { loader, fetchIndex, states, settle, posts: () => posts, advance: (ms: number) => { clock += ms; } };
}

const ok = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const unavailable = () => Promise.resolve(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

afterEach(() => { vi.useRealTimers(); });

describe('the blog search index loader', () => {
  it('loads once, however many interactions arrive while the request is in flight', async () => {
    const h = harness([ok([POST])]);
    h.loader.load(); h.loader.load(); h.loader.load();
    await h.settle();
    h.loader.load();
    expect(h.fetchIndex).toHaveBeenCalledTimes(1);
    expect(h.states).toEqual(['loading', 'ready']);
    expect(h.posts()).toEqual([POST]);
  });

  it('keeps a genuinely empty index as ready, not as a failure', async () => {
    const h = harness([ok([])]);
    h.loader.load(); await h.settle();
    expect(h.loader.state).toBe('ready');
    expect(h.posts()).toEqual([]);
  });

  it.each([
    ['a 503', unavailable],
    ['a network failure', offline],
    ['a body that is not a list', ok({ error: 'unavailable' })],
  ])('reports %s as unavailable, then retries on a later interaction', async (_, failure) => {
    const h = harness([failure, ok([POST])]);
    h.loader.load(); await h.settle();
    expect(h.loader.state).toBe('unavailable');

    // Not immediately: typing through an outage must not send a request per key.
    h.loader.load(); await h.settle();
    expect(h.fetchIndex).toHaveBeenCalledTimes(1);

    h.advance(SEARCH_INDEX_RETRY_AFTER_MS);
    h.loader.load(); await h.settle();
    expect(h.fetchIndex).toHaveBeenCalledTimes(2);
    expect(h.loader.state).toBe('ready');
    expect(h.posts()).toEqual([POST]);
  });

  it('gives up after a bounded number of attempts on one mount', async () => {
    const h = harness(Array.from({ length: SEARCH_INDEX_MAX_ATTEMPTS }, () => unavailable));
    for (let i = 0; i < SEARCH_INDEX_MAX_ATTEMPTS + 3; i += 1) {
      h.loader.load(); await h.settle();
      h.advance(SEARCH_INDEX_RETRY_AFTER_MS);
    }
    expect(h.fetchIndex).toHaveBeenCalledTimes(SEARCH_INDEX_MAX_ATTEMPTS);
    expect(h.loader.state).toBe('unavailable');
  });

  it('bounds a stalled fetch, aborts it, and permits a later successful interaction', async () => {
    vi.useFakeTimers();
    const h = harness([() => new Promise<Response>(() => {}), ok([POST])]);
    h.loader.load(); await h.settle();
    expect(h.loader.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.loader.state).toBe('unavailable');
    expect(h.fetchIndex.mock.calls[0][0]?.aborted).toBe(true);
    h.loader.load();
    expect(h.fetchIndex).toHaveBeenCalledTimes(1);
    h.advance(SEARCH_INDEX_RETRY_AFTER_MS);
    h.loader.load(); await h.settle();
    expect(h.loader.state).toBe('ready');
    expect(h.posts()).toEqual([POST]);
  });

  it('keeps the same deadline through a stalled response body', async () => {
    vi.useFakeTimers();
    const response = { ok: true, json: () => new Promise<unknown>(() => {}) } as Response;
    const h = harness([() => Promise.resolve(response)]);
    h.loader.load(); await h.settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.loader.state).toBe('unavailable');
    expect(h.fetchIndex.mock.calls[0][0]?.aborted).toBe(true);
  });

  it('ignores an old body that completes after a successful retry', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const body = new Promise<unknown>(resolve => { finish = resolve; });
    const h = harness([() => Promise.resolve({ ok: true, json: () => body } as Response), ok([POST])]);
    h.loader.load(); await h.settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.loader.state).toBe('unavailable');
    h.advance(SEARCH_INDEX_RETRY_AFTER_MS);
    h.loader.load(); await h.settle();
    expect(h.loader.state).toBe('ready');
    finish([{ ...POST, slug: 'old' }]); await h.settle();
    expect(h.posts()).toEqual([POST]);
    expect(h.states).toEqual(['loading', 'unavailable', 'loading', 'ready']);
  });

  it('reports a synchronous transport failure through the unavailable state', async () => {
    const h = harness([() => { throw new TypeError('transport unavailable'); }]);
    expect(() => h.loader.load()).not.toThrow();
    await h.settle();
    expect(h.loader.state).toBe('unavailable');
  });

  it('aborts on disposal without later state changes or another request', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const body = new Promise<unknown>(resolve => { finish = resolve; });
    const h = harness([() => Promise.resolve({ ok: true, json: () => body } as Response)]);
    h.loader.load(); await h.settle();
    h.loader.dispose();
    expect(h.fetchIndex.mock.calls[0][0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    finish([POST]); await h.settle();
    h.loader.load(); await h.settle();
    expect(h.states).toEqual(['loading']);
    expect(h.fetchIndex).toHaveBeenCalledTimes(1);
  });

  it('does not start a transport disposed before the scheduled call', async () => {
    vi.useFakeTimers();
    const h = harness([ok([POST])]);
    h.loader.load(); h.loader.dispose(); await h.settle();
    expect(h.fetchIndex).not.toHaveBeenCalled();
    expect(h.states).toEqual(['loading']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline on success instead of changing ready to unavailable later', async () => {
    vi.useFakeTimers();
    const h = harness([ok([POST])]);
    h.loader.load(); await h.settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.states).toEqual(['loading', 'ready']);
    expect(h.posts()).toEqual([POST]);
  });

  it('keeps the existing attempt cap when every transport stalls', async () => {
    vi.useFakeTimers();
    const h = harness(Array.from({ length: SEARCH_INDEX_MAX_ATTEMPTS }, () => () => new Promise<Response>(() => {})));
    for (let i = 0; i < SEARCH_INDEX_MAX_ATTEMPTS + 2; i++) {
      h.loader.load(); await h.settle();
      await vi.advanceTimersByTimeAsync(10_000);
      h.advance(SEARCH_INDEX_RETRY_AFTER_MS);
    }
    expect(h.fetchIndex).toHaveBeenCalledTimes(SEARCH_INDEX_MAX_ATTEMPTS);
    expect(h.loader.state).toBe('unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });
});
