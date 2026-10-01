import { describe, expect, it, vi } from 'vitest';
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
  const fetchIndex = vi.fn(() => {
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
});
