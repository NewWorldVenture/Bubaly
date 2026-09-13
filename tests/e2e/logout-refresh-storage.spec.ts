import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { BrowserSessionSnapshot } from '../../lib/auth/browser-session-storage';

// Real production factory, public SSR cookie adapter and installed auth SDK.
// Provider responses and explicitly labelled scheduling barriers are controlled.
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve(filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (name === '@supabase/supabase-js') { item.imports[name] = 'sdk'; continue; }
    let target: string;
    if (name.startsWith('@/')) target = path.resolve(name.slice(2)) + '.ts';
    else if (name.startsWith('.') && /\.ts$/.test(id)) target = path.resolve(path.dirname(id), name) + '.ts';
    else target = require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entry = collect('lib/supabase/client.ts');
const storageEntry = collect('lib/auth/browser-session-storage.ts');
const origin = 'https://logout-storage-fixture.invalid';
const provider = 'https://logout-storage.supabase.co';
const key = 'sb-logout-storage-auth-token';
const ids = { a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
type Probe = {
  signIn: (who: 'a' | 'b') => Promise<void>;
  snapshot: () => BrowserSessionSnapshot | null;
  clear: (snapshot: BrowserSessionSnapshot | null) => boolean;
  refresh: () => Promise<string | null>;
  user: () => Promise<string | null>;
  pauseWrite: () => void;
  writePaused: () => boolean;
  releaseWrite: () => void;
  pauseErrorBody: () => void;
  errorBodyPaused: () => boolean;
  releaseErrorBody: () => void;
  pauseDelete: () => void;
  deletePaused: () => boolean;
  releaseDelete: () => void;
  sdkSignOut: () => Promise<string | null>;
  startConcurrentRefresh: () => void;
  concurrentRefreshResult: () => string | null;
  events: () => string[];
};
declare global { interface Window { __logoutStorage: Probe } }
type Mode = 'normal' | 'incomplete' | 'unavailable' | 'rejected';

async function install(context: BrowserContext, large = false) {
  let mode: Mode = 'normal';
  let release: (() => void) | undefined;
  let hold: Promise<void> | undefined;
  let seenRefresh = 0;
  let revision = 0;
  const control = {
    mode: (value: Mode) => { mode = value; },
    hold: () => { hold = new Promise<void>(resolve => { release = resolve; }); },
    release: () => { release?.(); hold = undefined; },
    calls: () => seenRefresh,
  };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Logout storage fixture</body></html>' }); return;
    }
    if (url.origin !== provider) throw new Error(`Unexpected fixture origin: ${url.origin}`);
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/logout') { await route.fulfill({ headers, status: 204 }); return; }
    if (url.pathname !== '/auth/v1/token') throw new Error(`Unexpected fixture request: ${url.pathname}`);
    const body = route.request().postDataJSON() as { email?: string; refresh_token?: string };
    const who = (body.email?.startsWith('b@') || body.refresh_token?.startsWith('b-')) ? 'b' : 'a';
    if (url.searchParams.get('grant_type') === 'refresh_token') {
      seenRefresh++;
      if (hold) await hold;
      if (mode !== 'normal') {
        await route.fulfill({ headers, status: mode === 'unavailable' ? 503 : mode === 'rejected' ? 400 : 200,
          contentType: 'application/json', body: mode === 'incomplete' ? '{}' : JSON.stringify({ error_code: 'refresh_token_not_found', message: 'Synthetic renewal failure' }) }); return;
      }
    }
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const jwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: ids[who], session_id: `${who}-session`, exp: expires, revision: ++revision })).toString('base64url'),
      'synthetic-signature',
    ].join('.');
    const user = { id: ids[who], email: `${who}@fixture.invalid`, aud: 'authenticated', role: 'authenticated', app_metadata: {},
      user_metadata: large ? { fixture: 'x'.repeat(20000) } : {}, created_at: '2026-09-12T00:00:00Z' };
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ access_token: jwt,
      refresh_token: `${who}-refresh-${revision}`, token_type: 'bearer', expires_at: expires, expires_in: 3600, user }) });
  });
  return control;
}

async function load(page: Page) {
  await page.goto(origin);
  await page.addScriptTag({ content: sdk });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, loaded = {};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-anon-fixture' } };
    function load(id) {
      if (id === 'sdk') return window.supabase;
      if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module: ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process);
      return module.exports;
    }
    const storage = load(${JSON.stringify(storageEntry)});
    let pause = false, paused = false, release;
    let pauseErrorBody = false, errorBodyPaused = false, releaseErrorBody;
    let pauseDelete = false, deletePaused = false, releaseDelete;
    let concurrentRefreshResult = 'pending';
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (pauseErrorBody && !response.ok) {
        pauseErrorBody = false;
        return new Response(new ReadableStream({ start(controller) {
          errorBodyPaused = true;
          releaseErrorBody = async () => { controller.enqueue(new TextEncoder().encode(await response.text())); controller.close(); };
        }}), { status: response.status, headers: response.headers });
      }
      return response;
    };
    const makeStorage = storage.createBrowserSessionStorage;
    storage.createBrowserSessionStorage = url => {
      const adapter = makeStorage(url), write = adapter.cookies.setAll;
      adapter.cookies.setAll = async cookies => {
        if (pauseDelete && cookies.some(cookie => cookie.name === ${JSON.stringify(key)} && cookie.options.maxAge === 0)
          && cookies.every(cookie => cookie.options.maxAge === 0)) {
          pauseDelete = false; deletePaused = true;
          await new Promise(resolve => { releaseDelete = resolve; });
        }
        if (pause && cookies.some(cookie => cookie.name === ${JSON.stringify(key)} && cookie.options.maxAge !== 0)) {
          pause = false; paused = true;
          await new Promise(resolve => { release = resolve; });
        }
        return write(cookies);
      };
      return adapter;
    };
    const client = load(${JSON.stringify(entry)}).createClient();
    const events = [];
    client.auth.onAuthStateChange(event => { events.push(event); });
    window.__logoutStorage = {
      signIn: async who => { const result = await client.auth.signInWithPassword({ email: who + '@fixture.invalid', password: 'synthetic-password' }); if (result.error) throw result.error; },
      snapshot: storage.captureBrowserSessionSnapshot,
      clear: storage.clearBrowserSessionSnapshot,
      refresh: async () => { try { const result = await client.auth.refreshSession(); return result.error?.name ?? null; } catch (error) { return error.name; } },
      user: async () => { const result = await client.auth.getSession(); return result.data.session?.user.id ?? null; },
      pauseWrite: () => { pause = true; }, writePaused: () => paused, releaseWrite: () => { release?.(); }, events: () => events,
      pauseErrorBody: () => { pauseErrorBody = true; }, errorBodyPaused: () => errorBodyPaused,
      releaseErrorBody: () => { return releaseErrorBody?.(); },
      pauseDelete: () => { pauseDelete = true; }, deletePaused: () => deletePaused, releaseDelete: () => { releaseDelete?.(); },
      sdkSignOut: async () => { try { const result = await client.auth.signOut({ scope: 'local' }); return result.error?.name ?? null; } catch (error) { return error.name; } },
      startConcurrentRefresh: () => { concurrentRefreshResult = 'pending'; void window.__logoutStorage.refresh().then(result => { concurrentRefreshResult = result; }); },
      concurrentRefreshResult: () => concurrentRefreshResult,
    };
  })();` });
  await page.evaluate(() => window.__logoutStorage.user());
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('snapshot distinguishes absent storage from malformed bytes that remain explicitly clearable', async ({ context, page }) => {
  await install(context); await load(page);
  expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toBeNull();
  for (const cookie of [{ name: key, value: 'unreadable' }, { name: `${key}.1`, value: 'partial' }]) {
    await context.clearCookies(); await context.addCookies([{ ...cookie, url: origin }]);
    expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toMatchObject({ accessToken: null, userId: null, sessionId: null });
    expect(await page.evaluate(() => window.__logoutStorage.clear(window.__logoutStorage.snapshot()!))).toBe(true);
    expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toBeNull();
  }
});

test('explicit compare-and-clear removes every large session chunk and only configured project auxiliary cookies', async ({ context, page }) => {
  await install(context, true); await load(page); await page.evaluate(() => window.__logoutStorage.signIn('a'));
  await context.addCookies([
    { name: `${key}-user`, value: 'synthetic-user', url: origin }, { name: `${key}-code-verifier`, value: 'synthetic-verifier', url: origin },
    { name: 'sb-other-auth-token', value: 'untouched', url: origin }, { name: 'locale', value: 'en', url: origin },
  ]);
  const snapshot = await page.evaluate(() => window.__logoutStorage.snapshot());
  expect(snapshot?.cookies.length).toBeGreaterThan(7);
  expect(await page.evaluate(s => window.__logoutStorage.clear(s!), snapshot)).toBe(true);
  expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toBeNull();
  const cookies = await context.cookies(origin);
  expect(cookies.some(cookie => cookie.name === 'sb-other-auth-token')).toBe(true);
  expect(cookies.some(cookie => cookie.name === 'locale')).toBe(true);
  expect(cookies.find(cookie => cookie.name === `${key}-logout-generation`)).toMatchObject({ secure: true, sameSite: 'Lax', path: '/' });
});

test('stale confirmation snapshot cannot clear a new B session', async ({ context, page }) => {
  await install(context); await load(page); await page.evaluate(() => window.__logoutStorage.signIn('a'));
  const old = await page.evaluate(() => window.__logoutStorage.snapshot());
  await page.evaluate(() => window.__logoutStorage.signIn('b'));
  expect(await page.evaluate(s => window.__logoutStorage.clear(s!), old)).toBe(false);
  expect(await page.evaluate(() => window.__logoutStorage.user())).toBe(ids.b);
});

test('same-session rotation remains durable and a fresh snapshot still clears it', async ({ context, page }) => {
  await install(context); await load(page); await page.evaluate(() => window.__logoutStorage.signIn('a'));
  const old = await page.evaluate(() => window.__logoutStorage.snapshot());
  expect(await page.evaluate(() => window.__logoutStorage.refresh())).toBeNull();
  const fresh = await page.evaluate(() => window.__logoutStorage.snapshot());
  expect(fresh?.accessToken).not.toBe(old?.accessToken);
  expect(fresh?.sessionId).toBe(old?.sessionId);
  expect(await page.evaluate(s => window.__logoutStorage.clear(s!), old)).toBe(false);
  expect(await page.evaluate(s => window.__logoutStorage.clear(s!), fresh)).toBe(true);
});

for (const disabled of [false, true]) {
  test(`separate-tab logout fences a pending refresh and preserves a later B session${disabled ? ' without localStorage or BroadcastChannel' : ''}`, async ({ context, page }) => {
    if (disabled) await context.addInitScript(() => {
      Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
      Object.defineProperty(window, 'localStorage', { get: () => { throw new DOMException('Unavailable', 'SecurityError'); } });
    });
    const providerControl = await install(context); await load(page);
    await page.clock.install();
    await page.evaluate(() => window.__logoutStorage.signIn('a'));
    const other = await context.newPage(); await load(other);
    providerControl.hold();
    const refreshing = page.evaluate(() => window.__logoutStorage.refresh());
    await expect.poll(() => providerControl.calls()).toBe(1);
    expect(await other.evaluate(() => window.__logoutStorage.clear(window.__logoutStorage.snapshot()!))).toBe(true);
    await other.evaluate(() => window.__logoutStorage.signIn('b'));
    providerControl.release();
    await page.clock.runFor(40_000);
    expect(await refreshing).toBe('AuthRetryableFetchError');
    expect(providerControl.calls()).toBe(1);
    expect(await other.evaluate(() => window.__logoutStorage.user())).toBe(ids.b);
    expect(await page.evaluate(() => window.__logoutStorage.events())).not.toContain('TOKEN_REFRESHED');
  });
}

test('adapter rechecks logout after a successful refresh response and before its delayed cookie write', async ({ context, page }) => {
  await install(context); await load(page); await page.evaluate(() => window.__logoutStorage.signIn('a'));
  const other = await context.newPage(); await load(other);
  await page.evaluate(() => window.__logoutStorage.pauseWrite());
  const refreshing = page.evaluate(() => window.__logoutStorage.refresh());
  await expect.poll(() => page.evaluate(() => window.__logoutStorage.writePaused())).toBe(true);
  await other.evaluate(() => window.__logoutStorage.clear(window.__logoutStorage.snapshot()!));
  await other.evaluate(() => window.__logoutStorage.signIn('b'));
  await page.evaluate(() => window.__logoutStorage.releaseWrite());
  expect(await refreshing).toBe('AuthRetryableFetchError');
  expect(await other.evaluate(() => window.__logoutStorage.user())).toBe(ids.b);
  expect(await page.evaluate(() => window.__logoutStorage.events())).not.toContain('TOKEN_REFRESHED');
});

for (const mode of ['incomplete', 'unavailable'] as const) {
  test(`${mode} renewal retains the exact saved session`, async ({ context, page }) => {
    const providerControl = await install(context); await load(page); await page.clock.install();
    await page.evaluate(() => window.__logoutStorage.signIn('a'));
    const before = await page.evaluate(() => window.__logoutStorage.snapshot());
    providerControl.mode(mode);
    const refreshing = page.evaluate(() => window.__logoutStorage.refresh());
    await page.clock.runFor(40_000);
    expect(await refreshing).toBe('AuthRetryableFetchError');
    expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toEqual(before);
  });
}

test('cookie deletion failure is surfaced instead of claiming successful logout', async ({ context, page }) => {
  await install(context); await load(page); await page.evaluate(() => window.__logoutStorage.signIn('a'));
  const result = await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => descriptor.get!.call(document), set: () => {} });
    try { window.__logoutStorage.clear(window.__logoutStorage.snapshot()!); return 'unexpected-success'; }
    catch (error) { return (error as Error).message; }
  });
  expect(result).toBe('Logout state could not be persisted');
  expect(await page.evaluate(() => window.__logoutStorage.snapshot())).not.toBeNull();
});

test('cookie access failure remains a failure instead of an absent session', async ({ context, page }) => {
  await install(context); await load(page); await page.evaluate(() => window.__logoutStorage.signIn('a'));
  const result = await page.evaluate(() => {
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => { throw new DOMException('Storage unavailable', 'SecurityError'); } });
    try { window.__logoutStorage.snapshot(); return 'unexpected-success'; }
    catch (error) { return (error as Error).name; }
  });
  expect(result).toBe('SecurityError');
});

test('mismatched signed-token subject cannot supply a session comparison identity', async ({ context, page }) => {
  await install(context); await load(page); await page.evaluate(() => window.__logoutStorage.signIn('a'));
  const cookie = (await context.cookies(origin)).find(item => item.name === key)!;
  const value = JSON.parse(Buffer.from(cookie.value.slice(7), 'base64url').toString());
  value.user.id = ids.b;
  cookie.value = `base64-${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  await context.addCookies([cookie]);
  expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toMatchObject({ userId: ids.b, sessionId: null });
  expect(await page.evaluate(() => window.__logoutStorage.clear(window.__logoutStorage.snapshot()!))).toBe(true);
});

test('overlapping whole and chunk generations preserve exact bytes for confirmed removal', async ({ context, page }) => {
  await install(context); await load(page); await page.evaluate(() => window.__logoutStorage.signIn('a'));
  await context.addCookies([{ name: `${key}.0`, value: 'stale-chunk', url: origin }]);
  expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toMatchObject({ accessToken: null, userId: null, sessionId: null });
  expect(await page.evaluate(() => window.__logoutStorage.clear(window.__logoutStorage.snapshot()!))).toBe(true);
});

test('a definitive rejection still ends the currently expired session', async ({ context, page }) => {
  const providerControl = await install(context); await load(page); await page.evaluate(() => window.__logoutStorage.signIn('a'));
  const cookie = (await context.cookies(origin)).find(item => item.name === key)!;
  const value = JSON.parse(Buffer.from(cookie.value.slice(7), 'base64url').toString());
  value.expires_at = Math.floor(Date.now() / 1000) - 3600;
  cookie.value = `base64-${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  await context.addCookies([cookie]);
  providerControl.mode('rejected');
  expect(await page.evaluate(() => window.__logoutStorage.refresh())).toBe('AuthApiError');
  expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toBeNull();
});

test('explicit logout of an empty slot fences earlier renewal and refuses a new session', async ({ context, page }) => {
  const providerControl = await install(context); await load(page); await page.clock.install();
  await page.evaluate(() => window.__logoutStorage.signIn('a'));
  providerControl.hold();
  const refreshing = page.evaluate(() => window.__logoutStorage.refresh());
  await expect.poll(() => providerControl.calls()).toBe(1);
  await context.clearCookies();
  expect(await page.evaluate(() => window.__logoutStorage.clear(null))).toBe(true);
  providerControl.release();
  await page.clock.runFor(40_000);
  expect(await refreshing).toBe('AuthRetryableFetchError');
  expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toBeNull();
  await page.evaluate(() => window.__logoutStorage.signIn('b'));
  expect(await page.evaluate(() => window.__logoutStorage.clear(null))).toBe(false);
  expect(await page.evaluate(() => window.__logoutStorage.user())).toBe(ids.b);
});

test('logout works without the secure-context-only randomUUID API', async ({ context, page }) => {
  await install(context); await load(page); await page.evaluate(() => window.__logoutStorage.signIn('a'));
  expect(await page.evaluate(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
    return window.__logoutStorage.clear(window.__logoutStorage.snapshot());
  })).toBe(true);
  expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toBeNull();
});

test('logout during a delayed definitive error body cannot reject the newer B session', async ({ context, page }) => {
  const providerControl = await install(context); await load(page); await page.clock.install();
  await page.evaluate(() => window.__logoutStorage.signIn('a'));
  const other = await context.newPage(); await load(other);
  providerControl.mode('rejected');
  await page.evaluate(() => window.__logoutStorage.pauseErrorBody());
  const refreshing = page.evaluate(() => window.__logoutStorage.refresh());
  await expect.poll(() => page.evaluate(() => window.__logoutStorage.errorBodyPaused())).toBe(true);
  await other.evaluate(() => window.__logoutStorage.clear(window.__logoutStorage.snapshot()));
  await other.evaluate(() => window.__logoutStorage.signIn('b'));
  await page.evaluate(() => window.__logoutStorage.releaseErrorBody());
  await page.clock.runFor(40_000);
  expect(await refreshing).toBe('AuthRetryableFetchError');
  expect(providerControl.calls()).toBe(1);
  expect(await other.evaluate(() => window.__logoutStorage.user())).toBe(ids.b);
  expect(await page.evaluate(() => window.__logoutStorage.events())).not.toContain('SIGNED_OUT');
});


test('logout after a definitive rejection decision fences its delayed deletion and preserves B', async ({ context, page }) => {
  const providerControl = await install(context); await load(page);
  await page.evaluate(() => window.__logoutStorage.signIn('a'));
  const other = await context.newPage(); await load(other);
  const cookie = (await context.cookies(origin)).find(item => item.name === key)!;
  const value = JSON.parse(Buffer.from(cookie.value.slice(7), 'base64url').toString());
  value.expires_at = Math.floor(Date.now() / 1000) - 3600;
  cookie.value = `base64-${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  await context.addCookies([cookie]);
  providerControl.mode('rejected');
  await page.evaluate(() => window.__logoutStorage.pauseDelete());
  const refreshing = page.evaluate(() => window.__logoutStorage.refresh());
  await expect.poll(() => page.evaluate(() => window.__logoutStorage.deletePaused())).toBe(true);
  await other.evaluate(() => window.__logoutStorage.clear(window.__logoutStorage.snapshot()));
  await other.evaluate(() => window.__logoutStorage.signIn('b'));
  await page.evaluate(() => window.__logoutStorage.releaseDelete());
  expect(await refreshing).toBe('AuthRetryableFetchError');
  expect(await other.evaluate(() => window.__logoutStorage.user())).toBe(ids.b);
  expect(await page.evaluate(() => window.__logoutStorage.events())).not.toContain('SIGNED_OUT');
  // The rejected A operation must not prevent a later explicit SDK logout of B.
  expect(await page.evaluate(() => window.__logoutStorage.sdkSignOut())).toBeNull();
  expect(await page.evaluate(() => window.__logoutStorage.snapshot())).toBeNull();
});

test('a later explicit SDK logout remains available after a prior-generation rejection', async ({ context, page }) => {
  const providerControl = await install(context); await load(page);
  await page.evaluate(() => window.__logoutStorage.signIn('a'));
  providerControl.mode('rejected');
  // This token is still valid, so the SDK preserves it after proactive failure.
  expect(await page.evaluate(() => window.__logoutStorage.refresh())).toBe('AuthApiError');
  const other = await context.newPage(); await load(other);
  await other.evaluate(() => window.__logoutStorage.clear(window.__logoutStorage.snapshot()));
  await other.evaluate(() => window.__logoutStorage.signIn('b'));
  expect(await page.evaluate(() => window.__logoutStorage.sdkSignOut())).toBeNull();
  expect(await other.evaluate(() => window.__logoutStorage.snapshot())).toBeNull();
});


test('concurrent refresh callers both settle after obsolete rejection cleanup and B can sign out', async ({ context, page }) => {
  const providerControl = await install(context); await load(page);
  await page.evaluate(() => window.__logoutStorage.signIn('a'));
  const other = await context.newPage(); await load(other);
  const cookie = (await context.cookies(origin)).find(item => item.name === key)!;
  const value = JSON.parse(Buffer.from(cookie.value.slice(7), 'base64url').toString());
  value.expires_at = Math.floor(Date.now() / 1000) - 3600;
  cookie.value = 'base64-' + Buffer.from(JSON.stringify(value)).toString('base64url');
  await context.addCookies([cookie]);
  providerControl.mode('rejected');
  await page.evaluate(() => window.__logoutStorage.pauseDelete());
  const first = page.evaluate(() => window.__logoutStorage.refresh());
  await expect.poll(() => page.evaluate(() => window.__logoutStorage.deletePaused())).toBe(true);
  await page.evaluate(() => window.__logoutStorage.startConcurrentRefresh());
  expect(await page.evaluate(() => window.__logoutStorage.concurrentRefreshResult())).toBe('pending');
  expect(providerControl.calls()).toBe(1);
  await other.evaluate(() => window.__logoutStorage.clear(window.__logoutStorage.snapshot()));
  await other.evaluate(() => window.__logoutStorage.signIn('b'));
  // A's rejection was already received. The queued caller may now renew B.
  providerControl.mode('normal');
  await page.evaluate(() => window.__logoutStorage.releaseDelete());
  expect(await first).toBe('AuthRetryableFetchError');
  await expect.poll(() => page.evaluate(() => window.__logoutStorage.concurrentRefreshResult())).toBeNull();
  expect(providerControl.calls()).toBe(2);
  expect(await other.evaluate(() => window.__logoutStorage.user())).toBe(ids.b);
  expect(await page.evaluate(() => window.__logoutStorage.events())).not.toContain('SIGNED_OUT');
  expect(await page.evaluate(() => window.__logoutStorage.sdkSignOut())).toBeNull();
  expect(await other.evaluate(() => window.__logoutStorage.snapshot())).toBeNull();
});
