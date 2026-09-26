import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// SEC-001 / SUPPORT-98FD1D4C44AD. The service worker cached every successful
// same-origin image cache-first, whatever the response said about itself, and
// kept it across logout. Two private paths led into that cache:
//
//   * /_next/image — the optimizer is same-origin and keyed by URL, not by
//     session, so a family photo rendered through <Image> was stored and later
//     served offline to whoever opened the app next on that device;
//   * any same-origin response marked `Cache-Control: private` or `no-store`.
//
// This runs the REAL handlers from public/sw.js in a VM, against an in-memory
// CacheStorage and a scripted fetch, so what it proves is what the worker does
// rather than what its source text looks like.

const ORIGIN = 'https://app.bubaly.test';
const source = readFileSync('public/sw.js', 'utf8');

type FakeRequest = { method: string; url: string; mode: string; destination: string };

function loadWorker(respond: (url: string) => Response) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const store = new Map<string, Map<string, Response>>();
  const keyOf = (req: string | FakeRequest) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).toString();
  const cacheFor = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name)!;
    return {
      put: async (req: string | FakeRequest, res: Response) => { entries.set(keyOf(req), res); },
      addAll: async (urls: string[]) => { for (const u of urls) entries.set(keyOf(u), new Response('shell')); },
      match: async (req: string | FakeRequest) => entries.get(keyOf(req)),
    };
  };
  const caches = {
    open: async (name: string) => cacheFor(name),
    match: async (req: string | FakeRequest) => {
      for (const entries of store.values()) {
        const hit = entries.get(keyOf(req));
        if (hit) return hit;
      }
      return undefined;
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  };
  const fetches: string[] = [];
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; },
    location: new URL(ORIGIN),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
    registration: {},
  };
  const fetchImpl = async (req: FakeRequest | string) => {
    const url = typeof req === 'string' ? req : req.url;
    fetches.push(url);
    return respond(url);
  };
  vm.runInNewContext(source, { self, caches, fetch: fetchImpl, URL, Response, Promise, console, setTimeout });
  return { listeners, store, fetches };
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function get(worker: ReturnType<typeof loadWorker>, path: string, destination = 'image') {
  const request: FakeRequest = { method: 'GET', url: new URL(path, ORIGIN).toString(), mode: 'no-cors', destination };
  let responded: Promise<Response> | undefined;
  worker.listeners.fetch({ request, respondWith: (p: Promise<Response>) => { responded = p; } });
  const response = responded ? await responded : undefined;
  await settle();
  return response;
}

function cachedUrls(worker: ReturnType<typeof loadWorker>) {
  return [...worker.store.values()].flatMap((entries) => [...entries.keys()]);
}

const PHOTO = '/_next/image?url=https%3A%2F%2Fabcd.supabase.co%2Fstorage%2Fv1%2Fobject%2Fsign%2Ffamily-media%2Fx.jpg%3Ftoken%3Dt&w=640&q=75';

describe('the service worker keeps private images out of Cache Storage (SEC-001)', () => {
  it('does not store an optimizer response, so a family photo is not served to the next person offline', async () => {
    const worker = loadWorker(() => new Response('private family photo bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    await get(worker, PHOTO);
    expect(cachedUrls(worker).some((url) => url.includes('/_next/image'))).toBe(false);

    // And a second request goes to the network, not to a stored copy.
    await get(worker, PHOTO);
    expect(worker.fetches.filter((url) => url.includes('/_next/image'))).toHaveLength(2);
  });

  it('does not store a response the server marked private or no-store', async () => {
    for (const cacheControl of ['private, max-age=3600', 'no-store', 'private, no-store']) {
      const worker = loadWorker(() => new Response('bytes', { status: 200, headers: { 'cache-control': cacheControl } }));
      await get(worker, '/uploads/avatar.png');
      expect(cachedUrls(worker), cacheControl).not.toContain(`${ORIGIN}/uploads/avatar.png`);
    }
  });

  it('still caches public static assets (control)', async () => {
    const worker = loadWorker(() => new Response('asset', { status: 200, headers: { 'cache-control': 'public, max-age=31536000, immutable' } }));
    await get(worker, '/_next/static/chunks/app.js', 'script');
    await get(worker, '/icons/icon-192.png', 'image');
    const cached = cachedUrls(worker);
    expect(cached).toContain(`${ORIGIN}/_next/static/chunks/app.js`);
    expect(cached).toContain(`${ORIGIN}/icons/icon-192.png`);
  });

  it('leaves a signed Storage URL to the network: it is cross-origin (control)', async () => {
    const worker = loadWorker(() => new Response('bytes'));
    const request: FakeRequest = { method: 'GET', url: 'https://abcd.supabase.co/storage/v1/object/sign/family-media/x.jpg?token=t', mode: 'no-cors', destination: 'image' };
    let intercepted = false;
    worker.listeners.fetch({ request, respondWith: () => { intercepted = true; } });
    expect(intercepted).toBe(false);
  });

  it('purges the cache version that already retained private images', async () => {
    const worker = loadWorker(() => new Response('x'));
    worker.store.set('bubaly-v4', new Map([[`${ORIGIN}${PHOTO}`, new Response('retained private bytes')]]));
    worker.store.set('bubaly-library-v1', new Map([[`${ORIGIN}/library/media/ep1.mp3`, new Response('episode')]]));
    let done: Promise<unknown> | undefined;
    worker.listeners.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    expect(worker.store.has('bubaly-v4')).toBe(false);
    expect(worker.store.has('bubaly-library-v1')).toBe(true);
  });
});
