import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * SEC-001, the cache half: a private image must not be kept for the next user.
 *
 * Family photos live on the Supabase origin, which the worker skips. But Next's
 * image optimizer re-serves them from THIS origin at /_next/image, and
 * public/sw.js cached every successful same-origin image cache-first, with no
 * partition by session and no regard for Cache-Control. Logout clears cookies
 * and the query cache, not Cache Storage — so the next person to open the app
 * on a shared device was served the previous family's photos, offline, from
 * a cache nothing ever cleared.
 *
 * This runs the real worker file in a sandbox with a fake Cache Storage and
 * network, dispatches real-shaped fetch events, and reads what was stored.
 */

type Handler = (event: { request: FakeRequest; respondWith: (p: Promise<unknown>) => void; waitUntil: (p: Promise<unknown>) => void }) => void;
type FakeRequest = { url: string; method: string; mode: string; destination: string };
type FakeResponse = { ok: boolean; headers: { get: (name: string) => string | null }; clone: () => FakeResponse; body: string };

function response(body: string, cacheControl: string | null): FakeResponse {
  const r: FakeResponse = {
    ok: true, body,
    headers: { get: (name) => (name.toLowerCase() === 'cache-control' ? cacheControl : null) },
    clone: () => r,
  };
  return r;
}

function loadWorker(network: (url: string) => FakeResponse) {
  const stores = new Map<string, Map<string, FakeResponse>>();
  const handlers: Record<string, Handler> = {};
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        put: async (req: FakeRequest, res: FakeResponse) => { store.set(req.url, res); },
        addAll: async () => {},
      };
    },
    match: async (req: FakeRequest | string) => {
      const url = typeof req === 'string' ? req : req.url;
      for (const store of stores.values()) if (store.has(url)) return store.get(url);
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const self = {
    location: { origin: 'https://bubaly.test' },
    addEventListener: (type: string, fn: Handler) => { handlers[type] = fn; },
    registration: {}, clients: { claim: async () => {} }, skipWaiting: () => {},
  };
  runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, caches, fetch: async (req: FakeRequest) => network(req.url), URL, console });
  const source = readFileSync('public/sw.js', 'utf8');
  const cacheName = /const CACHE = '([^']+)'/.exec(source)![1];

  async function get(path: string, destination: string) {
    const request: FakeRequest = { url: `https://bubaly.test${path}`, method: 'GET', mode: 'no-cors', destination };
    let responded: Promise<unknown> | undefined;
    handlers.fetch({ request, respondWith: (p) => { responded = p; }, waitUntil: () => {} });
    const res = await responded;
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget put land
    return res as FakeResponse;
  }
  const stored = (path: string) => stores.get(cacheName)?.has(`https://bubaly.test${path}`) ?? false;
  return { get, stored, cacheName };
}

describe('the service worker keeps nothing private for the next user', () => {
  it('still caches content-hashed static scripts and public images (control)', async () => {
    const sw = loadWorker(() => response('bytes', 'public, max-age=31536000, immutable'));
    await sw.get('/_next/static/chunks/app.js', 'script');
    await sw.get('/icons/icon-192.png', 'image');
    expect(sw.stored('/_next/static/chunks/app.js')).toBe(true);
    expect(sw.stored('/icons/icon-192.png')).toBe(true);
  });

  // The finding.
  it('never caches an image-optimizer response, which can carry family media', async () => {
    const sw = loadWorker(() => response('family A photo', 'public, max-age=60'));
    await sw.get('/_next/image?url=https%3A%2F%2Fproj.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Ffamily-media%2Fa.jpg&w=640&q=75', 'image');
    expect(sw.stored('/_next/image?url=https%3A%2F%2Fproj.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Ffamily-media%2Fa.jpg&w=640&q=75')).toBe(false);
  });

  it('never caches a response the server marked private or no-store', async () => {
    const sw = loadWorker((url) => response('x', url.includes('private') ? 'private, max-age=60' : 'no-store'));
    await sw.get('/private.png', 'image');
    await sw.get('/nostore.png', 'image');
    expect(sw.stored('/private.png')).toBe(false);
    expect(sw.stored('/nostore.png')).toBe(false);
  });

  it('serves the next request from the network, not from a previous user', async () => {
    let served = 'family A photo';
    const sw = loadWorker(() => response(served, 'public, max-age=60'));
    const path = '/_next/image?url=x&w=640&q=75';
    expect((await sw.get(path, 'image')).body).toBe('family A photo');
    served = 'family B photo';
    expect((await sw.get(path, 'image')).body).toBe('family B photo');
  });

  it('bumped the cache version, so what v4 already holds is purged on activate', () => {
    const source = readFileSync('public/sw.js', 'utf8');
    expect(source).not.toContain("'bubaly-v4'");
  });
});
