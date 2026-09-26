import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * SEC-001's service-worker half, EXECUTED rather than read.
 *
 * public/sw.js v4 cached every successful same-origin style, script or IMAGE —
 * and /_next/image is same-origin with `destination: 'image'`. It is the Next
 * image optimizer: a proxy that renders whatever URL it is handed, including a
 * family's private photos. Those bytes went into Cache Storage, were served
 * cache-first, and survived logout, so on a shared device the next person to open
 * the app offline was shown the previous one's photos. The earlier audit cycle
 * reproduced exactly that in real Chromium (see SEC-001).
 *
 * This runs the ACTUAL worker file in a VM with a fake `self`, `caches` and
 * `fetch`, dispatches real `Request` objects at its fetch listener, and inspects
 * what it stored. A source-text assertion could not tell the difference between a
 * guard that runs and one that has been reordered below the `put`.
 */
const SRC = readFileSync(`${process.cwd()}/public/sw.js`, 'utf8');
const ORIGIN = 'https://www.bubaly.test';

type Stored = Map<string, Map<string, Response>>;

function boot(network: (req: Request) => Response) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const stored: Stored = new Map();
  const pending: Promise<unknown>[] = [];
  const cacheFor = (name: string) => {
    if (!stored.has(name)) stored.set(name, new Map());
    const m = stored.get(name)!;
    return {
      put: async (req: Request, res: Response) => { m.set(req.url, res); },
      match: async (req: Request) => m.get(req.url),
      addAll: async (urls: string[]) => { for (const u of urls) m.set(new URL(u, ORIGIN).href, new Response('shell')); },
    };
  };
  const caches = {
    open: async (name: string) => cacheFor(name),
    match: async (req: Request | string) => {
      const key = typeof req === 'string' ? new URL(req, ORIGIN).href : req.url;
      for (const m of stored.values()) if (m.has(key)) return m.get(key);
      return undefined;
    },
    keys: async () => [...stored.keys()],
    delete: async (name: string) => stored.delete(name),
  };
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  runInNewContext(SRC, { self, caches, fetch: async (r: Request) => network(r), URL, Response, Request, Promise, console });

  async function get(path: string, destination: string): Promise<Response | undefined> {
    const request = new Request(new URL(path, ORIGIN).href);
    Object.defineProperty(request, 'destination', { value: destination });
    Object.defineProperty(request, 'mode', { value: 'no-cors' });
    let responded: Promise<Response> | undefined;
    listeners.fetch({ request, respondWith: (p: Promise<Response>) => { responded = p; } });
    const res = responded ? await responded : undefined;
    // Let the fire-and-forget `caches.open(...).then(put)` settle before asserting.
    await new Promise((r) => setTimeout(r, 0));
    await Promise.all(pending);
    return res;
  }
  async function activate() {
    let wait: Promise<unknown> | undefined;
    listeners.activate({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
  }
  const storedUrls = () => [...stored.values()].flatMap((m) => [...m.keys()]);
  return { get, activate, stored, storedUrls };
}

const image = (cc?: string) => () => new Response('bytes', { status: 200, headers: cc ? { 'Cache-Control': cc } : {} });

describe('a private image does not outlive the session that fetched it', () => {
  let sw: ReturnType<typeof boot>;

  it('does not store an optimized image, even when Next marks it public', async () => {
    // The case that matters: Next's optimizer emits `public` whatever the source
    // was, so honouring the header alone would STILL have stored this. It is
    // excluded by path.
    sw = boot(image('public, max-age=60, must-revalidate'));
    const res = await sw.get('/_next/image?url=https%3A%2F%2Fx.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Ffamily-media%2Fa.jpg&w=640&q=75', 'image');
    // The worker declines to handle it at all, so the browser goes to the network.
    expect(res).toBeUndefined();
    expect(sw.storedUrls().some((u) => u.includes('/_next/image'))).toBe(false);
  });

  it('does not store an image whose response says private or no-store', async () => {
    for (const cc of ['private, max-age=300', 'no-store', 'private,no-store', 'max-age=0, private']) {
      sw = boot(image(cc));
      await sw.get('/uploads/avatar.png', 'image');
      expect(sw.storedUrls(), `stored despite Cache-Control: ${cc}`).not.toContain(`${ORIGIN}/uploads/avatar.png`);
    }
  });

  it('still caches a public static image and a hashed script — offline must keep working', async () => {
    // The positive control. A fix that stopped caching everything would pass the
    // two cases above and quietly break the offline app shell.
    sw = boot(image('public, max-age=31536000, immutable'));
    await sw.get('/icons/icon-192.png', 'image');
    await sw.get('/_next/static/chunks/main-abc123.js', 'script');
    expect(sw.storedUrls()).toContain(`${ORIGIN}/icons/icon-192.png`);
    expect(sw.storedUrls()).toContain(`${ORIGIN}/_next/static/chunks/main-abc123.js`);
  });

  it('does not mistake a directive that merely CONTAINS the word for the directive', async () => {
    // `private` must match as a directive, not as a substring of some other token.
    sw = boot(image('public, max-age=600, x-privateish=1'));
    await sw.get('/icons/logo.png', 'image');
    expect(sw.storedUrls()).toContain(`${ORIGIN}/icons/logo.png`);
  });

  it('purges what v4 stored when the new worker activates', async () => {
    // Existing devices already hold private images in `bubaly-v4`. The version
    // bump is what removes them: the activate sweep deletes every cache that is
    // not the current one or the family's downloaded-episode cache.
    sw = boot(image());
    sw.stored.set('bubaly-v4', new Map([[`${ORIGIN}/_next/image?url=private`, new Response('old bytes')]]));
    sw.stored.set('bubaly-library-v1', new Map([[`${ORIGIN}/library/media/ep1`, new Response('episode')]]));
    await sw.activate();
    expect(sw.stored.has('bubaly-v4')).toBe(false);
    expect(sw.stored.has('bubaly-library-v1')).toBe(true);
  });

  beforeEach(() => { /* each case boots its own worker */ });
});
