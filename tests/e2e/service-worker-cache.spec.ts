import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Production worker handlers, logout modules and real Chromium CacheStorage.
// Event delivery and transport are controlled. This is not native SW registration
// or a real Next image optimizer; no app server or provider is contacted.
const workerSource = fs.readFileSync('public/sw.js', 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve(filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
  } }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (name === '@supabase/supabase-js') { item.imports[name] = 'sdk'; continue; }
    let target: string | undefined;
    if (name.startsWith('@/') || (name.startsWith('.') && /\.tsx?$/.test(id))) {
      const base = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(id), name);
      target = ['.ts', '.tsx', '.js'].map(extension => base + extension).find(file => fs.existsSync(file));
    } else target = require.resolve(name, { paths: [path.dirname(id)] });
    if (!target) throw new Error('Every production import must resolve');
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries(['lib/auth/browser-signout.ts', 'lib/auth/browser-session-storage.ts', 'lib/offline/cache.ts'].map(file => [file, collect(file)]));
const ORIGIN = 'https://sw-cache-fixture.invalid';
const CURRENT = 'bubaly-v6';
const LIBRARY = 'bubaly-library-v1';
const PRIVATE_IMAGE = '/_next/image?url=%2Fsynthetic-private-family-image.png&w=256&q=75';
const EPISODE = '/library/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type RequestOptions = { destination?: RequestDestination; navigate?: boolean; method?: string; headers?: Record<string, string> };
type Reply = { body?: string; status?: number; headers?: Record<string, string>; redirected?: boolean; url?: string; type?: ResponseType };
type Result = { handled: boolean; body: string | null; status: number | null; rejected: boolean };
type CacheFault = 'open' | 'match' | 'put' | 'keys' | 'delete' | null;
type Probe = {
  offline: boolean; hold: boolean; fault: CacheFault; reply: Reply;
  fetches: { url: string; credentials: RequestCredentials; redirect: RequestRedirect }[];
  operations: { kind: string; cache?: string }[]; claimed: number; skipped: number;
  dispatch: (url: string, options?: RequestOptions) => Promise<Result>;
  lifecycle: (kind: 'install' | 'activate') => Promise<boolean>;
  release: () => void; flush: () => Promise<void>;
  seed: (who: 'a' | 'b') => boolean;
  logout: () => Promise<{ status: string; emptySession: boolean; emptyQueryCache: boolean }>;
};
declare global { interface Window { __swCache: Probe } }

const errors = new WeakMap<Page, string[]>();
const unexpected = new WeakMap<Page, string[]>();
test.use({ serviceWorkers: 'block', trace: 'off', screenshot: 'off', video: 'off' });
test.beforeEach(async ({ page, context }) => {
  const failures: string[] = [], requests: string[] = [];
  errors.set(page, failures); unexpected.set(page, requests);
  page.on('pageerror', error => failures.push(error.name));
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.url() === ORIGIN + '/' && request.method() === 'GET') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Cache ownership fixture</body></html>' }); return;
    }
    if (request.url() === ORIGIN + EPISODE && request.method() === 'GET') {
      await route.fulfill({ contentType: 'audio/mpeg', body: 'synthetic-publisher-audio' }); return;
    }
    requests.push(request.method()); await route.abort('blockedbyclient');
  });
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: sdk });
  await page.evaluate(({ workerSource, modules, entries }) => {
    const loaded: Record<string, { exports: unknown }> = {};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://sw-cache-owner.supabase.co' } };
    function load(id: string): unknown {
      if (id === 'sdk') return (window as unknown as { supabase: unknown }).supabase;
      if (loaded[id]) return loaded[id].exports;
      const item = modules[id], loadedModule = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)((name: string) => load(item.imports[name]), loadedModule, loadedModule.exports, process);
      return loadedModule.exports;
    }
    const signout = load(entries['lib/auth/browser-signout.ts']) as typeof import('../../lib/auth/browser-signout');
    const storage = load(entries['lib/auth/browser-session-storage.ts']) as typeof import('../../lib/auth/browser-session-storage');
    const offlineCache = load(entries['lib/offline/cache.ts']) as typeof import('../../lib/offline/cache');
    type DeliveredEvent = { request: Request; respondWith: (value: Response | Promise<Response>) => void; waitUntil: (value: Promise<unknown>) => void };
    const listeners = new Map<string, (event: DeliveredEvent) => void>();
    const tasks = new Set<Promise<unknown>>();
    const held: (() => void)[] = [];
    const waits: Promise<unknown>[] = [];
    const track = <T,>(promise: Promise<T>): Promise<T> => {
      tasks.add(promise); void promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise;
    };
    const p: Probe = {
      offline: false, hold: false, fault: null, reply: {}, fetches: [], operations: [], claimed: 0, skipped: 0,
      dispatch: async () => { throw new Error('Not initialized'); }, lifecycle: async () => false,
      release: () => { p.hold = false; held.splice(0).forEach(resolve => resolve()); },
      flush: async () => {
        await Promise.resolve();
        while (tasks.size) await Promise.allSettled([...tasks]);
        await Promise.all(waits.splice(0));
      },
      seed: who => {
        const userId = who === 'a' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        const sessionId = who === 'a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
        const base64url = (text: string) => btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const access_token = base64url('{"alg":"HS256"}') + '.' + base64url(JSON.stringify({ sub: userId, session_id: sessionId, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.synthetic-signature';
        document.cookie = 'sb-sw-cache-owner-auth-token=' + encodeURIComponent('base64-' + base64url(JSON.stringify({ access_token, refresh_token: 'synthetic-' + who, user: { id: userId } }))) + '; Path=/; Secure; SameSite=Lax';
        offlineCache.writeCache('bub:cache:synthetic-family:photos', [{ synthetic: who }]);
        return storage.captureBrowserSessionSnapshot()?.userId === userId;
      },
      logout: async () => {
        const intent = signout.captureSignOutIntent();
        if (!intent) throw new Error('Synthetic session must have a logout intent');
        const result = signout.signOutBrowserSession(intent, { revoke: false }); await result.revocation;
        return { status: result.status, emptySession: storage.captureBrowserSessionSnapshot() === null,
          emptyQueryCache: localStorage.getItem('bub:cache:synthetic-family:photos') === null };
      },
    };
    const cacheApi = {
      open: (name: string) => track((async () => {
        p.operations.push({ kind: 'open', cache: name });
        if (p.fault === 'open') throw new Error('Controlled open refusal');
        const cache = await caches.open(name);
        return {
          match: (request: RequestInfo) => track((async () => {
            p.operations.push({ kind: 'match', cache: name });
            if (p.fault === 'match') throw new Error('Controlled match refusal');
            return cache.match(request);
          })()),
          put: (request: RequestInfo, response: Response) => track((async () => {
            p.operations.push({ kind: 'put', cache: name });
            if (p.fault === 'put') throw new Error('Controlled put refusal');
            return cache.put(request, response);
          })()),
          addAll: (requests: RequestInfo[]) => track(cache.addAll(requests)),
        };
      })()),
      keys: () => track((async () => {
        p.operations.push({ kind: 'keys' });
        if (p.fault === 'keys') throw new Error('Controlled keys refusal');
        return caches.keys();
      })()),
      delete: (name: string) => track((async () => {
        p.operations.push({ kind: 'delete', cache: name });
        if (p.fault === 'delete') throw new Error('Controlled delete refusal');
        return caches.delete(name);
      })()),
      match: (request: RequestInfo) => track((async () => {
        p.operations.push({ kind: 'global-match' }); return caches.match(request);
      })()),
    };
    const network = async (input: RequestInfo | URL, options?: RequestInit) => {
      const request = new Request(typeof input === 'string' ? new URL(input, location.origin) : input, options);
      p.fetches.push({ url: request.url, credentials: request.credentials, redirect: request.redirect });
      const reply = { ...p.reply };
      if (p.hold) await new Promise<void>(resolve => held.push(resolve));
      if (p.offline) throw new TypeError('Controlled offline transport');
      const pathname = new URL(request.url).pathname;
      const mime = ['/', '/offline'].includes(pathname) ? 'text/html' : pathname.startsWith('/library/media/') ? 'audio/mpeg'
        : pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'image/png';
      const response = new Response(reply.body ?? 'synthetic-network', { status: reply.status ?? 200, headers: { 'content-type': mime, ...reply.headers } });
      Object.defineProperties(response, {
        url: { value: reply.url ?? request.url }, type: { value: reply.type ?? 'basic' }, redirected: { value: reply.redirected ?? false },
      });
      return response;
    };
    new Function('self', 'caches', 'fetch', workerSource)({
      location: { origin: location.origin }, addEventListener: (type: string, listener: (event: DeliveredEvent) => void) => listeners.set(type, listener),
      clients: { claim: async () => { p.claimed++; } }, skipWaiting: async () => { p.skipped++; },
    }, cacheApi, network);
    p.dispatch = async (raw, options = {}) => {
      const request = new Request(new URL(raw, location.origin), { method: options.method ?? 'GET', headers: options.headers });
      Object.defineProperty(request, 'destination', { value: options.destination ?? '' });
      if (options.navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
      let response: Promise<Response> | undefined;
      listeners.get('fetch')!({ request, respondWith: value => { response = Promise.resolve(value); }, waitUntil: value => { waits.push(value); } });
      try {
        // An unhandled request follows the browser's ordinary network path.
        const actual = await (response ?? network(request));
        const result = { handled: Boolean(response), body: await actual.text(), status: actual.status, rejected: false };
        await p.flush(); return result;
      } catch { await p.flush(); return { handled: Boolean(response), body: null, status: null, rejected: true }; }
    };
    p.lifecycle = async kind => {
      try {
        listeners.get(kind)!({ request: new Request(location.origin), respondWith: () => {}, waitUntil: value => { waits.push(value); } });
        await p.flush(); return true;
      } catch { return false; }
    };
    window.__swCache = p;
  }, { workerSource, modules, entries });
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  expect(unexpected.get(page)).toEqual([]);
});

async function dispatch(page: Page, url: string, options: RequestOptions = {}) {
  return page.evaluate(({ url, options }) => window.__swCache.dispatch(url, options), { url, options });
}
async function seedCache(page: Page, name: string, url: string, body: string) {
  await page.evaluate(async ({ name, url, body }) => {
    const address = new URL(url, location.origin);
    const mime = address.pathname.startsWith('/library/media/') ? 'audio/mpeg'
      : ['/', '/offline'].includes(address.pathname) || address.pathname.startsWith('/dashboard') ? 'text/html' : 'image/png';
    await (await caches.open(name)).put(address.href, new Response(body, { headers: { 'content-type': mime } }));
  }, { name, url, body });
}
async function cacheHas(page: Page, name: string, url: string) {
  return page.evaluate(async ({ name, url }) => Boolean(await (await caches.open(name)).match(new URL(url, location.origin).href)), { name, url });
}

test('private optimized images cannot replay after actual logout and a new identity', async ({ page }) => {
  expect(await page.evaluate(() => window.__swCache.seed('a'))).toBe(true);
  await page.evaluate(() => { window.__swCache.reply = { body: 'owner-A-private-image', headers: { 'cache-control': 'private, no-store', 'content-type': 'image/png' } }; });
  expect((await dispatch(page, PRIVATE_IMAGE, { destination: 'image' })).body).toBe('owner-A-private-image');
  expect(await page.evaluate(() => window.__swCache.logout())).toEqual({ status: 'signed-out', emptySession: true, emptyQueryCache: true });
  expect(await page.evaluate(() => window.__swCache.seed('b'))).toBe(true);
  await page.evaluate(() => { window.__swCache.offline = true; });
  expect(await dispatch(page, PRIVATE_IMAGE, { destination: 'image' })).toMatchObject({ body: null, rejected: true });
  expect(await page.evaluate(() => window.__swCache.operations)).toEqual([]);
});

for (const name of ['bubaly-v3', 'bubaly-v4', 'bubaly-v5', CURRENT, LIBRARY]) {
  test(`private image seeded in ${name} is never read`, async ({ page }) => {
    await seedCache(page, name, PRIVATE_IMAGE, 'owner-A-private-image');
    await page.evaluate(() => { window.__swCache.offline = true; });
    expect(await dispatch(page, PRIVATE_IMAGE, { destination: 'image' })).toMatchObject({ body: null, rejected: true });
    expect(await page.evaluate(() => window.__swCache.operations)).toEqual([]);
  });
}

for (const url of ['/family/photo.png', '/icons/unknown.png', '/icons/icon-192.png?user=a', '/icons/%69con-192.png',
  '/_next/image?url=https%3A%2Fprivate.supabase.co%2Ffamily.png&w=256&q=75',
  '/_next/image?url=%2Fbrand%2Fbubaly-logo.png&w=256&q=75&url=%2Fprivate.png',
  '/_next/image?url=%2Fbrand%2Fbubaly-logo.png&w=256&q=75&user=a',
  '/_next/static/private.png', '/api/family-media', '/auth/private.png', 'https://outside.invalid/image.png']) {
  test(`does not cache dynamic or unreviewed resource ${url}`, async ({ page }) => {
    await seedCache(page, CURRENT, url, 'poisoned-cache');
    expect((await dispatch(page, url, { destination: 'image' })).body).toBe('synthetic-network');
    expect(await page.evaluate(() => window.__swCache.operations)).toEqual([]);
  });
}

test('non-GET requests never consult caches', async ({ page }) => {
  expect((await dispatch(page, '/icons/icon-192.png', { destination: 'image', method: 'POST' })).body).toBe('synthetic-network');
  expect(await page.evaluate(() => window.__swCache.operations)).toEqual([]);
});

for (const [url, destination] of [
  ['/icons/icon-192.png', 'image'], ['/brand/bubaly-logo.png', 'image'],
  ['/_next/static/chunks/app.js?dpl=dpl_test', 'script'], ['/_next/static/css/app.css', 'style'],
  ['/_next/image?url=%2Fbrand%2Fbubaly-logo.png&w=256&q=75', 'image'],
] as const) {
  test(`public resource remains available offline: ${url}`, async ({ page }) => {
    await page.evaluate(() => { window.__swCache.reply = { body: 'reviewed-public-asset' }; });
    expect((await dispatch(page, url, { destination })).body).toBe('reviewed-public-asset');
    expect(await cacheHas(page, CURRENT, url)).toBe(true);
    await page.evaluate(() => { window.__swCache.offline = true; });
    expect((await dispatch(page, url, { destination })).body).toBe('reviewed-public-asset');
    expect(await page.evaluate(() => window.__swCache.fetches.length)).toBe(1);
    expect(await page.evaluate(() => window.__swCache.operations.some(item => item.kind === 'global-match'))).toBe(false);
  });
}

for (const reply of [
  { headers: { 'cache-control': 'private, max-age=600' } }, { headers: { 'cache-control': 'public, no-store' } },
  { status: 401 }, { status: 500 }, { redirected: true }, { url: 'https://outside.invalid/file.png' }, { type: 'opaque' as const },
]) {
  test(`does not persist unsafe public-path response ${JSON.stringify(reply)}`, async ({ page }) => {
    await page.evaluate(reply => { window.__swCache.reply = reply; }, reply);
    await dispatch(page, '/icons/icon-192.png', { destination: 'image' });
    expect(await cacheHas(page, CURRENT, '/icons/icon-192.png')).toBe(false);
  });
}

const unsafeCachedReplies: Reply[] = [
  { headers: { 'cache-control': 'private, no-store', 'content-type': 'image/png' } },
  { headers: { 'content-type': 'text/html' } }, { status: 403, headers: { 'content-type': 'image/png' } },
];
for (const reply of unsafeCachedReplies) {
  test(`rejects unsafe cached resource hits ${JSON.stringify(reply)}`, async ({ page }) => {
    await page.evaluate(async ({ reply, CURRENT }) => {
      await (await caches.open(CURRENT)).put('/icons/icon-192.png', new Response('unsafe-cached-bytes', reply));
    }, { reply, CURRENT });
    expect((await dispatch(page, '/icons/icon-192.png', { destination: 'image' })).body).toBe('synthetic-network');
  });
}

for (const url of ['/_next/static/chunks/app.js?user=a', '/_next/static/chunks/app.js?dpl=dpl_a&dpl=dpl_b',
  '/_next/static/chunks/%2fapp.js', '/_next/static/chunks/%255capp.js', '/_next/static/app.css']) {
  test(`script resource admission rejects ${url}`, async ({ page }) => {
    await dispatch(page, url, { destination: 'script' });
    expect(await page.evaluate(() => window.__swCache.operations)).toEqual([]);
  });
}

for (const query of ['url=%2Fbrand%2Fbubaly-logo.png&w=0256&q=75', 'url=%2Fbrand%2Fbubaly-logo.png&w=256&q=0',
  'url=%2Fbrand%2Fbubaly-logo.png&w=256&q=101', 'url=%252Fbrand%252Fbubaly-logo.png&w=256&q=75',
  'url=%2Fbrand%2Fbubaly-logo.png%3Fuser%3Da&w=256&q=75']) {
  test(`optimizer rejects noncanonical public input ${query}`, async ({ page }) => {
    await dispatch(page, '/_next/image?' + query, { destination: 'image' });
    expect(await page.evaluate(() => window.__swCache.operations)).toEqual([]);
  });
}

test('encoded Next route chunks retain public offline caching', async ({ page }) => {
  const url = '/_next/static/chunks/app/%28app%29/dashboard/%5Bid%5D/page.js?dpl=dpl_test';
  await dispatch(page, url, { destination: 'script' });
  expect(await cacheHas(page, CURRENT, url)).toBe(true);
});

test('private navigation never reads stale HTML from an old cache recreated after activation', async ({ page }) => {
  await seedCache(page, 'bubaly-v4', '/dashboard/photos', 'old-private-html');
  await seedCache(page, CURRENT, '/offline', 'public-offline-shell');
  expect(await page.evaluate(() => window.__swCache.lifecycle('activate'))).toBe(true);
  // Recreate the old cache AFTER activation, as an already-running v4 fetch can.
  await seedCache(page, 'bubaly-v4', '/dashboard/photos', 'late-private-html');
  await seedCache(page, 'bubaly-v4', PRIVATE_IMAGE, 'late-private-image');
  await page.evaluate(() => { window.__swCache.offline = true; });
  expect((await dispatch(page, '/dashboard/photos', { navigate: true })).body).toBe('public-offline-shell');
  expect(await dispatch(page, PRIVATE_IMAGE, { destination: 'image' })).toMatchObject({ body: null, rejected: true });
});

test('activation removes old and unknown caches while preserving current shell and explicit audio', async ({ page }) => {
  for (const name of ['bubaly-v3', 'bubaly-v4', 'bubaly-v5', 'unrelated-old-cache']) await seedCache(page, name, '/old', 'old');
  await seedCache(page, CURRENT, '/offline', 'public-offline-shell');
  await seedCache(page, LIBRARY, EPISODE, 'publisher-audio');
  expect(await page.evaluate(() => window.__swCache.lifecycle('activate'))).toBe(true);
  expect((await page.evaluate(() => caches.keys())).sort()).toEqual([LIBRARY, CURRENT].sort());
  expect(await page.evaluate(() => window.__swCache.claimed)).toBe(1);
  expect(await cacheHas(page, CURRENT, '/offline')).toBe(true);
  expect(await cacheHas(page, LIBRARY, EPISODE)).toBe(true);
});

test('a private request finishing after logout never enters CacheStorage', async ({ page }) => {
  await page.evaluate(() => { window.__swCache.seed('a'); window.__swCache.hold = true; window.__swCache.reply = { body: 'late-owner-A' }; });
  const pending = dispatch(page, PRIVATE_IMAGE, { destination: 'image' });
  await expect.poll(() => page.evaluate(() => window.__swCache.fetches.length)).toBe(1);
  expect((await page.evaluate(() => window.__swCache.logout())).status).toBe('signed-out');
  await page.evaluate(() => { window.__swCache.seed('b'); window.__swCache.release(); });
  expect((await pending).body).toBe('late-owner-A');
  expect(await page.evaluate(() => window.__swCache.operations)).toEqual([]);
  await page.evaluate(() => { window.__swCache.offline = true; });
  expect((await dispatch(page, PRIVATE_IMAGE, { destination: 'image' })).rejected).toBe(true);
});

for (const url of ['/', '/offline']) {
  test(`public shell network and offline navigation: ${url}`, async ({ page }) => {
    await page.evaluate(() => { window.__swCache.reply = { body: 'public-shell' }; });
    expect((await dispatch(page, url, { navigate: true })).body).toBe('public-shell');
    expect(await cacheHas(page, CURRENT, url)).toBe(true);
    await page.evaluate(() => { window.__swCache.offline = true; });
    expect((await dispatch(page, url, { navigate: true })).body).toBe('public-shell');
  });
}

for (const [url, options] of [['/?code=synthetic', { navigate: true }], ['/offline?user=a', { navigate: true }],
  ['/', { headers: { RSC: '1' } }]] as const) {
  test(`query or RSC requests are excluded from public shell storage ${url}`, async ({ page }) => {
    await seedCache(page, CURRENT, url, 'old-personalized-result');
    await dispatch(page, url, options);
    expect(await page.evaluate(() => window.__swCache.operations.filter(item => ['put', 'match', 'global-match'].includes(item.kind)))).toEqual([]);
  });
}

const protocolHeaders: Record<string, string>[] = [{ RSC: '1' }, { 'Next-Router-State-Tree': 'synthetic' }, { 'Next-Action': 'synthetic' }];
for (const headers of protocolHeaders) {
  test(`navigation protocol headers never overwrite the shell ${JSON.stringify(headers)}`, async ({ page }) => {
    await dispatch(page, '/', { navigate: true, headers });
    expect(await cacheHas(page, CURRENT, '/')).toBe(false);
  });
}

const unsafeNavigationReplies: Reply[] = [{ headers: { 'content-type': 'text/x-component' } }, { status: 500 }, { redirected: true },
  { headers: { 'cache-control': 'private, no-store' } }];
for (const reply of unsafeNavigationReplies) {
  test(`unsafe navigation responses do not enter the shell ${JSON.stringify(reply)}`, async ({ page }) => {
    await page.evaluate(reply => { window.__swCache.reply = reply; }, reply);
    await dispatch(page, '/offline', { navigate: true });
    expect(await cacheHas(page, CURRENT, '/offline')).toBe(false);
  });
}

test('install fetches only public shell without credentials and disallows redirects', async ({ page }) => {
  expect(await page.evaluate(() => window.__swCache.lifecycle('install'))).toBe(true);
  const fetches = await page.evaluate(() => window.__swCache.fetches);
  expect(fetches.map(item => new URL(item.url).pathname).sort()).toEqual(['/', '/offline']);
  expect(fetches.every(item => item.credentials === 'omit' && item.redirect === 'error')).toBe(true);
  expect(await page.evaluate(() => window.__swCache.skipped)).toBe(1);
});

test('explicit publisher download survives activation and logout, supports Range lookup and removal', async ({ page }) => {
  await page.evaluate(async ({ LIBRARY, EPISODE }) => { await (await caches.open(LIBRARY)).add(EPISODE); window.__swCache.seed('a'); }, { LIBRARY, EPISODE });
  expect(await page.evaluate(() => window.__swCache.lifecycle('activate'))).toBe(true);
  expect((await page.evaluate(() => window.__swCache.logout())).status).toBe('signed-out');
  await page.evaluate(() => { window.__swCache.offline = true; });
  expect((await dispatch(page, EPISODE, { destination: 'audio' })).body).toBe('synthetic-publisher-audio');
  expect((await dispatch(page, EPISODE, { destination: 'audio', headers: { Range: 'bytes=4-' } })).body).toBe('synthetic-publisher-audio');
  // A stored full response is the preexisting behavior; this does not claim
  // media-element decoding or native seek playback from a partial response.
  await page.evaluate(async ({ LIBRARY, EPISODE }) => { await (await caches.open(LIBRARY)).delete(EPISODE); }, { LIBRARY, EPISODE });
  expect((await dispatch(page, EPISODE, { destination: 'audio' })).rejected).toBe(true);
});

test('publisher cache miss fetches without saving and ignores app-cache audio', async ({ page }) => {
  await seedCache(page, CURRENT, EPISODE, 'wrong-cache-audio');
  expect((await dispatch(page, EPISODE, { destination: 'audio' })).body).toBe('synthetic-network');
  expect(await cacheHas(page, LIBRARY, EPISODE)).toBe(false);
  expect(await page.evaluate(() => window.__swCache.operations.some(item => item.kind === 'put'))).toBe(false);
});

test('HTML in the publisher cache is never served as downloaded media', async ({ page }) => {
  await page.evaluate(async ({ LIBRARY, EPISODE }) => {
    await (await caches.open(LIBRARY)).put(EPISODE, new Response('private-html', { headers: { 'content-type': 'text/html' } }));
  }, { LIBRARY, EPISODE });
  expect((await dispatch(page, EPISODE, { destination: 'audio' })).body).toBe('synthetic-network');
});

test('publisher navigation gets only the offline page, never downloaded bytes', async ({ page }) => {
  await seedCache(page, CURRENT, '/offline', 'public-offline-shell');
  await seedCache(page, LIBRARY, EPISODE, 'publisher-audio');
  await page.evaluate(() => { window.__swCache.offline = true; });
  expect((await dispatch(page, EPISODE, { navigate: true })).body).toBe('public-offline-shell');
});

for (const url of [EPISODE + '?user=a', '/library/media/not-an-item', EPISODE + '/extra']) {
  test(`publisher exception does not broaden to ${url}`, async ({ page }) => {
    await seedCache(page, LIBRARY, url, 'wrong-private-cache');
    expect((await dispatch(page, url, { destination: 'audio' })).body).toBe('synthetic-network');
    expect(await page.evaluate(() => window.__swCache.operations)).toEqual([]);
  });
}

for (const fault of ['open', 'match', 'put'] as const) {
  test(`cache ${fault} refusal preserves valid network response`, async ({ page }) => {
    await page.evaluate(fault => { window.__swCache.fault = fault; }, fault);
    expect((await dispatch(page, '/icons/icon-192.png', { destination: 'image' })).body).toBe('synthetic-network');
  });
}

for (const fault of ['keys', 'delete'] as const) {
  test(`activation ${fault} refusal cannot enable private replay`, async ({ page }) => {
    await seedCache(page, 'bubaly-v4', PRIVATE_IMAGE, 'old-private-image');
    await page.evaluate(fault => { window.__swCache.fault = fault; }, fault);
    expect(await page.evaluate(() => window.__swCache.lifecycle('activate'))).toBe(true);
    expect(await page.evaluate(() => window.__swCache.claimed)).toBe(1);
    await page.evaluate(() => { window.__swCache.offline = true; });
    expect((await dispatch(page, PRIVATE_IMAGE, { destination: 'image' })).rejected).toBe(true);
    expect(await page.evaluate(() => window.__swCache.operations.some(item => item.kind === 'global-match'))).toBe(false);
  });
}
