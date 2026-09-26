// The worker wrote the privacy rule down, then cached photos against it.
//
// public/sw.js opens with a PRIVACY INVARIANT (M-023): authenticated responses
// must never reach Cache Storage, because they "persist unencrypted after
// logout and would be served offline to whoever next opens the app on a
// shared/family device". The navigation branch honours it. The asset branch,
// two dozen lines below, cached anything whose `destination` was image/style/
// script the moment it came back 200.
//
// Three facts turn that into cross-account disclosure of a family's photos:
//
//   1. `/_next/image` is SAME-ORIGIN, so the cross-origin early return never
//      saw it — and it is the optimizer proxy in front of private family media.
//   2. The read is CACHE-FIRST, so once an image is in `bubaly-v4` it is served
//      with no network request at all. Nothing server-side can deny it.
//   3. Logout clears cookies and partitioned storage. It does not clear Cache
//      Storage. The entry outlives the session that was allowed to see it.
//
// So on the shared family device this product is built around, account B was
// served account A's photo. This file DRIVES the real handler against a fake
// CacheStorage rather than reading its source, because the previous guard for
// this file asserted spelling and would have passed throughout.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

type Handler = (event: FetchEventLike) => void;
type FetchEventLike = { request: RequestLike; respondWith: (r: Promise<ResponseLike>) => void };
type RequestLike = { url: string; method: string; mode: string; destination: string };
type ResponseLike = { ok: boolean; headers: { get: (k: string) => string | null }; clone: () => ResponseLike; body: string };

/** A Cache Storage stand-in that records what the worker chose to persist. */
function makeCaches() {
  const stores = new Map<string, Map<string, ResponseLike>>();
  const api = {
    stores,
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name) as Map<string, ResponseLike>;
      return { put: async (req: RequestLike, res: ResponseLike) => { store.set(req.url, res); } };
    },
    match: async (req: RequestLike | string) => {
      const key = typeof req === 'string' ? req : req.url;
      for (const store of stores.values()) if (store.has(key)) return store.get(key);
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  return api;
}

function response(body: string, cacheControl: string | null): ResponseLike {
  const res: ResponseLike = {
    ok: true,
    body,
    headers: { get: (k: string) => (k.toLowerCase() === 'cache-control' ? cacheControl : null) },
    clone: () => res,
  };
  return res;
}

/** Load public/sw.js with a synthetic global scope and return its fetch handler. */
function loadWorker() {
  const listeners = new Map<string, Handler>();
  const cacheApi = makeCaches();
  const fetches: string[] = [];
  let served: ResponseLike | undefined;

  const scope = {
    addEventListener: (type: string, fn: Handler) => { listeners.set(type, fn); },
    location: { origin: 'https://bubaly.test' },
    caches: cacheApi,
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: async () => [], openWindow: async () => null },
    registration: { showNotification: async () => {} },
  };

  const fetchImpl = async (req: RequestLike) => {
    fetches.push(req.url);
    return pending.get(req.url) ?? response('network', null);
  };
  const pending = new Map<string, ResponseLike>();

  const source = readFileSync('public/sw.js', 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const run = new Function('self', 'caches', 'fetch', 'URL', 'Request', `${source}\n`);
  run(scope, cacheApi, fetchImpl, URL, class {});

  const dispatch = async (request: RequestLike) => {
    served = undefined;
    const handler = listeners.get('fetch');
    if (!handler) throw new Error('the worker registered no fetch handler');
    let settled: Promise<ResponseLike> | undefined;
    handler({ request, respondWith: (r) => { settled = r; } });
    if (settled) served = await settled;
    // let the fire-and-forget caches.open(...).put(...) settle
    await new Promise((r) => setTimeout(r, 0));
    return served;
  };

  return { dispatch, cacheApi, fetches, pending, scope };
}

const imageRequest = (url: string): RequestLike => ({ url, method: 'GET', mode: 'no-cors', destination: 'image' });

let worker: ReturnType<typeof loadWorker>;
beforeEach(() => { worker = loadWorker(); });

/** Every URL the worker persisted, across all its caches. */
const stored = () => [...worker.cacheApi.stores.values()].flatMap((s) => [...s.keys()]);

describe('a private photo does not outlive the session in the worker cache', () => {
  it('does not persist an optimized image the server marked private', async () => {
    // THE CASE THEIR REGRESSION RECORDED AS RED: a /_next/image response marked
    // `private, no-store` was retained in bubaly-v4.
    const url = 'https://bubaly.test/_next/image?url=%2Ffamily%2Fphoto.jpg&w=640';
    worker.pending.set(url, response('A-private-bytes', 'private, no-store'));

    await worker.dispatch(imageRequest(url));

    expect(stored()).not.toContain(url);
  });

  it('serves the next account from the network rather than the previous one from cache', async () => {
    // The disclosure itself, end to end. Account A loads a photo; account B asks
    // for the same URL afterwards. B must reach the network — where the server
    // can still deny them — not be handed A's bytes by the worker.
    const url = 'https://bubaly.test/_next/image?url=%2Ffamily%2Fphoto.jpg&w=640';
    worker.pending.set(url, response('A-private-bytes', 'private, no-store'));
    await worker.dispatch(imageRequest(url));

    worker.pending.set(url, response('B-denied', 'private, no-store'));
    const second = await worker.dispatch(imageRequest(url));

    expect(second?.body).toBe('B-denied');
    expect(worker.fetches.filter((u) => u === url)).toHaveLength(2);
  });

  it('does not persist optimized family media even when the optimizer calls it public', async () => {
    // Family media is uploaded with cacheControl 31536000, so the optimizer can
    // return it publicly cacheable. Respecting the header alone is therefore not
    // enough: what /_next/image proxies is chosen by the page, not by the worker.
    const url = 'https://bubaly.test/_next/image?url=%2Ffamily%2Fphoto.jpg&w=1200';
    worker.pending.set(url, response('A-private-bytes', 'public, max-age=31536000, immutable'));

    await worker.dispatch(imageRequest(url));

    expect(stored()).not.toContain(url);
  });

  it('still caches the app is own static assets', async () => {
    // NOT BLIND. The worker must still be a PWA: its own fingerprinted assets
    // are public, immutable and exactly what offline support needs. A guard that
    // passed by caching nothing would be worthless.
    const css = 'https://bubaly.test/_next/static/css/app.css';
    worker.pending.set(css, response('body{}', 'public, max-age=31536000, immutable'));
    await worker.dispatch({ url: css, method: 'GET', mode: 'no-cors', destination: 'style' });

    const logo = 'https://bubaly.test/icons/icon-192.png';
    worker.pending.set(logo, response('png', 'public, max-age=31536000'));
    await worker.dispatch(imageRequest(logo));

    expect(stored()).toContain(css);
    expect(stored()).toContain(logo);
  });

  it('serves a cached static asset without a second network request', async () => {
    // The other half of not-blind: caching must still WORK, or the first two
    // cases would pass on a worker that had simply stopped functioning.
    const css = 'https://bubaly.test/_next/static/css/app.css';
    worker.pending.set(css, response('body{}', 'public, max-age=31536000, immutable'));
    await worker.dispatch({ url: css, method: 'GET', mode: 'no-cors', destination: 'style' });
    await worker.dispatch({ url: css, method: 'GET', mode: 'no-cors', destination: 'style' });

    expect(worker.fetches.filter((u) => u === css)).toHaveLength(1);
  });

  it('keeps refusing any asset a response declares private', async () => {
    // The header rule is general, not a special case for images.
    const url = 'https://bubaly.test/_next/static/chunks/private.js';
    worker.pending.set(url, response('secret', 'private'));
    await worker.dispatch({ url, method: 'GET', mode: 'no-cors', destination: 'script' });
    expect(stored()).not.toContain(url);
  });
});
