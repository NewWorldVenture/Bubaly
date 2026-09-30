import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAdjacentPosts, getAllPosts, getCategoryCounts, getFeaturedPost, getPost, getPostsByCategory, getRelatedPosts,
} from '@/lib/blog/posts';

// A public navigation waits on these reads. With the data API stalled, /blog
// sent no byte for as long as the stall lasted (measured past 100 s; see
// docs/audit/evidence/2026-09-30-ipad-blog-viewport-timeout/). Every read now
// runs under a budget, and running out degrades exactly like a failed read.
//
// The data API here never answers: each request settles only when its abort
// signal fires. The budget's timers are replaced so the test controls when the
// budget runs out instead of waiting for it.
let budgets: Array<{ ms: number; controller: AbortController }> = [];
let requests = 0;
let sentAfterDeadline = 0;

beforeEach(() => {
  budgets = [];
  requests = 0;
  sentAfterDeadline = 0;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    budgets.push({ ms, controller });
    return controller.signal;
  });
  vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
    requests += 1;
    const signal = init?.signal;
    if (signal?.aborted) sentAfterDeadline += 1;
    return new Promise((_, reject) => {
      const fail = () => reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) fail(); else signal?.addEventListener('abort', fail, { once: true });
    });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function outlivesTheStall<T>(read: Promise<T>): Promise<T> {
  let settled = false;
  void read.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  expect(settled, 'still waiting while the data API is stalled').toBe(false);
  expect(budgets.length).toBeGreaterThan(0);
  // Keep ending budgets until the read settles (a fallback read opens its own).
  for (let round = 0; round < 10 && !settled; round += 1) {
    for (const { controller } of budgets) if (!controller.signal.aborted) controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
  return read;
}

describe('blog reads cannot hold a public navigation open', () => {
  it.each([
    ['getAllPosts', () => getAllPosts(), []],
    ['getCategoryCounts', () => getCategoryCounts(), {}],
    ['getFeaturedPost', () => getFeaturedPost(), undefined],
    ['getPostsByCategory', () => getPostsByCategory('Parenting'), []],
    ['getPost', () => getPost('a-real-article'), undefined],
    ['getRelatedPosts', () => getRelatedPosts('a-real-article', 'Parenting'), []],
    ['getAdjacentPosts', () => getAdjacentPosts('2026-09-30T00:00:00Z'), { prev: null, next: null }],
  ] as const)('%s degrades when its budget runs out', async (_, read, degraded) => {
    await expect(outlivesTheStall(read())).resolves.toEqual(degraded);
    expect(budgets.every(({ ms }) => ms === 4_000)).toBe(true);
    expect(requests).toBeGreaterThan(0);
  });

  it('one budget covers every page of a paged read, and the SDK retry cannot outlive it', async () => {
    await outlivesTheStall(getAllPosts());
    expect(budgets).toHaveLength(1);
    // The SDK retries a failed GET after 1 s, 2 s and 4 s. Its backoff sleeps
    // on the query's own signal, which is the budget, so the sleeps end at once
    // and every retry is handed the fired signal: fetch rejects it before
    // sending. One request went out; nothing waits past the budget.
    expect(requests - sentAfterDeadline).toBe(1);
    expect(requests).toBeLessThanOrEqual(4);
    expect(console.error).toHaveBeenCalledWith('[blog] getAllPosts failed — rendering an empty list', expect.anything());
  });
});
