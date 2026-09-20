import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Installed SDK/SSR adapter, real React, actual cookies, and two browser tabs.
// The only server is an intercepted synthetic auth provider; no preview runs.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve(filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (['react', 'next/navigation', '@/lib/native/capacitor', '@capacitor/app'].includes(name)) { item.imports[name] = name; continue; }
    if (name === '@supabase/supabase-js') { item.imports[name] = 'sdk'; continue; }
    let target: string;
    if (name.startsWith('@/') || (name.startsWith('.') && /\.tsx?$/.test(id))) {
      const base = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(id), name);
      target = ['.ts', '.tsx', '.js', ''].map(extension => base + extension).find(candidate => fs.existsSync(candidate))!;
    } else target = require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries([
  'lib/supabase/client.ts', 'lib/auth/cache-session.ts', 'lib/auth/session-change.ts',
  'lib/offline/cache.ts', 'components/auth/session-keeper.tsx',
  'lib/auth/browser-session-storage.ts',
].map(file => [file, collect(file)]));
const origin = 'https://session-reconcile-fixture.invalid';
const provider = 'https://reconcile-fixture.supabase.co';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type Transport = 'both' | 'storage-only' | 'broadcast-only';
type Probe = {
  signIn: (user: 'a' | 'b') => Promise<void>; mount: (user: 'a' | 'b') => void;
  clearCookies: () => void; notify: () => void;
  snapshot: () => { status: string; identity: { userId: string } | null };
  revision: () => number; generation: () => number;
  realtimeToken: () => string | null;
  holdNextEmptyRead: () => void; releaseRead: () => Promise<void>; readHeld: boolean;
  pauseEmptyRemoval: () => void; releaseRemoval: () => void; removalHeld: boolean;
  sdkSignOut: () => Promise<void>;
  refreshes: number; events: string[]; errors: string[];
};
declare global { interface Window { __storageReconcile: Probe } }

async function install(context: BrowserContext) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }); return;
    }
    if (url.origin !== provider) throw new Error(`Unexpected fixture destination: ${url.origin}`);
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname !== '/auth/v1/token' || url.searchParams.get('grant_type') !== 'password') throw new Error(`Unexpected fixture request: ${url.pathname}`);
    const userId = route.request().postDataJSON().email === 'b@example.invalid' ? B : A;
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const claims = { sub: userId, session_id: userId === A ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', exp: expires, aud: 'authenticated' };
    const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-signature'].join('.');
    await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({
      access_token: token, refresh_token: `synthetic-refresh-${userId}`, token_type: 'bearer', expires_in: 3600, expires_at: expires,
      user: { id: userId, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' },
    }) });
  });
}

async function load(page: Page, transport: Transport = 'both') {
  await page.goto(origin);
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: sdk });
  await page.addScriptTag({ content: `(() => {
    if (${JSON.stringify(transport)} === 'storage-only') window.BroadcastChannel = undefined;
    if (${JSON.stringify(transport)} === 'broadcast-only') Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Fixture storage denied'); } });
    const sources = ${JSON.stringify(modules)}, entries = ${JSON.stringify(entries)}, loaded = {};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon' } };
    const p = window.__storageReconcile = { refreshes: 0, events: [], errors: [], readHeld: false, removalHeld: false };
    window.addEventListener('unhandledrejection', event => p.errors.push(String(event.reason)));
    const mocks = { react: React, sdk: window.supabase, 'next/navigation': { useRouter: () => router }, '@/lib/native/capacitor': { isNative: () => false } };
    const router = { refresh: () => { p.refreshes += 1; } };
    function load(id) {
      if (id in mocks) return mocks[id];
      if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module: ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process);
      return module.exports;
    }
    const storage = load(entries['lib/auth/browser-session-storage.ts']);
    const makeStorage = storage.createBrowserSessionStorage;
    let emptyReads = 0, releaseRemoval;
    storage.createBrowserSessionStorage = url => {
      const adapter = makeStorage(url), read = adapter.cookies.getAll;
      adapter.cookies.getAll = async () => {
        const cookies = read();
        if (emptyReads > 0 && --emptyReads === 0) {
          if (cookies.some(cookie => /^sb-reconcile-fixture-auth-token(?:\\.\\d+)?$/.test(cookie.name))) throw new Error('Expected empty removal lookup');
          p.removalHeld = true;
          await new Promise(resolve => { releaseRemoval = resolve; });
        }
        return cookies;
      };
      return adapter;
    };
    const client = load(entries['lib/supabase/client.ts']).createClient();
    const store = load(entries['lib/auth/cache-session.ts']);
    const changes = load(entries['lib/auth/session-change.ts']);
    const cache = load(entries['lib/offline/cache.ts']);
    const Keeper = load(entries['components/auth/session-keeper.tsx']).SessionKeeper;
    client.auth.onAuthStateChange(event => p.events.push(event));
    p.signIn = async user => {
      const { error } = await client.auth.signInWithPassword({ email: user + '@example.invalid', password: 'synthetic-password' });
      if (error) throw error;
    };
    let root;
    p.mount = user => {
      root ??= ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(Keeper, { userId: user === 'a' ? ${JSON.stringify(A)} : ${JSON.stringify(B)} })));
    };
    p.clearCookies = () => {
      for (const item of document.cookie.split(';')) {
        const name = item.trim().split('=')[0];
        if (/^sb-reconcile-fixture-auth-token(?:\\.\\d+)?$/.test(name)) document.cookie = name + '=; Max-Age=0; Path=/; Secure; SameSite=Lax';
      }
    };
    p.notify = changes.notifySessionStorageChanged;
    p.snapshot = store.getCacheSessionSnapshot;
    p.revision = changes.getSessionStorageChangeRevision;
    p.generation = cache.getCacheGeneration;
    p.realtimeToken = () => client.realtime.accessTokenValue;
    let releaseRead;
    p.holdNextEmptyRead = () => {
      const original = client.auth.getSession.bind(client.auth);
      client.auth.getSession = async () => {
        client.auth.getSession = original;
        const result = await original();
        if (result.data.session !== null || result.error) throw new Error('Expected a real successful empty SDK read');
        p.readHeld = true;
        await new Promise(resolve => { releaseRead = resolve; });
        return result;
      };
    };
    p.releaseRead = async () => { releaseRead(); await store.refreshCacheSession(); };
    p.pauseEmptyRemoval = () => { emptyReads = 2; };
    p.releaseRemoval = () => releaseRemoval();
    p.sdkSignOut = async () => { const { error } = await client.auth.signOut({ scope: 'local' }); if (error) throw error; };
  })();` });
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

for (const [sender, receiver] of [
  ['both', 'both'], ['storage-only', 'both'], ['both', 'storage-only'],
  ['storage-only', 'storage-only'], ['broadcast-only', 'broadcast-only'],
] as const) {
  test(`confirmed cookie removal reconciles both tabs once with ${sender}/${receiver}`, async ({ context, page }) => {
    await install(context); await load(page, sender);
    await page.evaluate(() => window.__storageReconcile.signIn('a'));
    const second = await context.newPage(); await load(second, receiver);
    for (const target of [page, second]) {
      await target.evaluate(() => window.__storageReconcile.mount('a'));
      await expect.poll(() => target.evaluate(() => window.__storageReconcile.snapshot().identity?.userId)).toBe(A);
    }
    const before = await second.evaluate(() => ({ revision: window.__storageReconcile.revision(), generation: window.__storageReconcile.generation() }));
    await page.evaluate(() => { const p = window.__storageReconcile; p.clearCookies(); p.notify(); });
    for (const target of [page, second]) {
      await expect.poll(() => target.evaluate(() => window.__storageReconcile.snapshot().status)).toBe('signed-out');
      await expect.poll(() => target.evaluate(() => window.__storageReconcile.refreshes)).toBe(1);
      expect(await target.evaluate(() => window.__storageReconcile.realtimeToken())).toBe('synthetic-public-anon');
      expect(await target.evaluate(() => window.__storageReconcile.events.filter(event => event === 'SIGNED_OUT'))).toEqual([]);
      expect(await target.evaluate(() => window.__storageReconcile.errors)).toEqual([]);
    }
    expect(await second.evaluate(() => window.__storageReconcile.revision())).toBe(before.revision + 1);
    expect(await second.evaluate(() => window.__storageReconcile.generation())).toBe(before.generation + 1);
  });
}

test('a delayed old logout notification rereads the new session in both tabs without purging it', async ({ context, page }) => {
  await install(context); await load(page);
  await page.evaluate(() => window.__storageReconcile.signIn('a'));
  const second = await context.newPage(); await load(second);
  await page.evaluate(() => window.__storageReconcile.signIn('b'));
  for (const target of [page, second]) {
    await target.evaluate(() => window.__storageReconcile.mount('b'));
    await expect.poll(() => target.evaluate(() => window.__storageReconcile.snapshot().identity?.userId)).toBe(B);
  }
  const before = await second.evaluate(() => ({ revision: window.__storageReconcile.revision(), generation: window.__storageReconcile.generation() }));
  await page.evaluate(() => window.__storageReconcile.notify());
  await expect.poll(() => second.evaluate(() => window.__storageReconcile.revision())).toBe(before.revision + 1);
  for (const target of [page, second]) {
    expect(await target.evaluate(() => window.__storageReconcile.snapshot().identity?.userId)).toBe(B);
    expect(await target.evaluate(() => window.__storageReconcile.refreshes)).toBe(0);
    expect(await target.evaluate(() => window.__storageReconcile.realtimeToken())).not.toBe('synthetic-public-anon');
    expect(await target.evaluate(() => window.__storageReconcile.errors)).toEqual([]);
  }
  expect(await second.evaluate(() => window.__storageReconcile.generation())).toBe(before.generation);
});

test('a held real empty SDK receipt cannot purge B when B cookies arrive before any auth broadcast', async ({ context, page }) => {
  await install(context); await load(page, 'storage-only');
  await page.evaluate(async () => { const p = window.__storageReconcile; await p.signIn('b'); p.mount('b'); });
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.snapshot().identity?.userId)).toBe(B);
  const second = await context.newPage(); await load(second, 'storage-only');
  const before = await page.evaluate(() => ({ generation: window.__storageReconcile.generation(), events: [...window.__storageReconcile.events] }));
  await page.evaluate(() => { const p = window.__storageReconcile; p.clearCookies(); p.holdNextEmptyRead(); p.notify(); });
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.readHeld)).toBe(true);
  await second.evaluate(() => window.__storageReconcile.signIn('b'));
  expect(await page.evaluate(() => window.__storageReconcile.events)).toEqual(before.events);
  await page.evaluate(() => window.__storageReconcile.releaseRead());
  expect(await page.evaluate(() => window.__storageReconcile.snapshot())).toMatchObject({ status: 'ready', identity: { userId: B }, error: null });
  expect(await page.evaluate(() => window.__storageReconcile.generation())).toBe(before.generation);
  expect(await page.evaluate(() => window.__storageReconcile.refreshes)).toBe(0);
  expect(await page.evaluate(() => window.__storageReconcile.realtimeToken())).not.toBe('synthetic-public-anon');
  expect(await page.evaluate(() => window.__storageReconcile.errors)).toEqual([]);
});

test('a real SDK SIGNED_OUT event after a zero-write cleanup cannot retire newly saved B cookies', async ({ context, page }) => {
  await install(context); await load(page, 'storage-only');
  await page.evaluate(async () => { const p = window.__storageReconcile; await p.signIn('b'); p.mount('b'); });
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.snapshot().identity?.userId)).toBe(B);
  const second = await context.newPage(); await load(second, 'storage-only');
  const generation = await page.evaluate(() => window.__storageReconcile.generation());
  await page.evaluate(() => { const p = window.__storageReconcile; p.clearCookies(); p.pauseEmptyRemoval(); });
  const signOut = page.evaluate(() => window.__storageReconcile.sdkSignOut());
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.removalHeld)).toBe(true);
  await second.evaluate(() => window.__storageReconcile.signIn('b'));
  await page.evaluate(() => window.__storageReconcile.releaseRemoval()); await signOut;
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.events.includes('SIGNED_OUT'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.snapshot().identity?.userId)).toBe(B);
  expect(await page.evaluate(() => window.__storageReconcile.generation())).toBe(generation);
  expect(await page.evaluate(() => window.__storageReconcile.refreshes)).toBe(0);
  expect(await page.evaluate(() => window.__storageReconcile.realtimeToken())).not.toBe('synthetic-public-anon');
  expect(await page.evaluate(() => window.__storageReconcile.errors)).toEqual([]);
});

test('a cookie-only B sign-in reconciles the peer realtime token when SDK broadcasts are unavailable', async ({ context, page }) => {
  await install(context); await load(page, 'storage-only');
  await page.evaluate(async () => { const p = window.__storageReconcile; await p.signIn('a'); p.mount('a'); });
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.snapshot().identity?.userId)).toBe(A);
  const second = await context.newPage(); await load(second, 'storage-only');
  const events = await page.evaluate(() => [...window.__storageReconcile.events]);
  await second.evaluate(() => window.__storageReconcile.signIn('b'));
  expect(await page.evaluate(() => window.__storageReconcile.events)).toEqual(events);
  await second.evaluate(() => window.__storageReconcile.notify());
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.snapshot().identity?.userId)).toBe(B);
  const token = await page.evaluate(() => window.__storageReconcile.realtimeToken());
  expect(JSON.parse(Buffer.from(token!.split('.')[1], 'base64url').toString()).sub).toBe(B);
  expect(await page.evaluate(() => window.__storageReconcile.refreshes)).toBe(1);
  expect(await page.evaluate(() => window.__storageReconcile.errors)).toEqual([]);
});

test('a suppressed stale SDK sign-out refreshes an A server tree to newly saved B immediately', async ({ context, page }) => {
  await install(context); await load(page, 'storage-only');
  await page.evaluate(async () => { const p = window.__storageReconcile; await p.signIn('a'); p.mount('a'); });
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.snapshot().identity?.userId)).toBe(A);
  const second = await context.newPage(); await load(second, 'storage-only');
  await page.evaluate(() => { const p = window.__storageReconcile; p.clearCookies(); p.pauseEmptyRemoval(); });
  const signOut = page.evaluate(() => window.__storageReconcile.sdkSignOut());
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.removalHeld)).toBe(true);
  await second.evaluate(() => window.__storageReconcile.signIn('b'));
  await page.evaluate(() => window.__storageReconcile.releaseRemoval()); await signOut;
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.snapshot().identity?.userId)).toBe(B);
  await expect.poll(() => page.evaluate(() => window.__storageReconcile.refreshes)).toBe(1);
  expect(await second.evaluate(() => window.__storageReconcile.revision())).toBe(0);
  const token = await page.evaluate(() => window.__storageReconcile.realtimeToken());
  expect(JSON.parse(Buffer.from(token!.split('.')[1], 'base64url').toString()).sub).toBe(B);
  expect(await page.evaluate(() => window.__storageReconcile.errors)).toEqual([]);
});
