import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { SignOutBridge } from '../../lib/auth/signout-bridge';

// Actual React controls, browser helpers, SSR cookie adapter and installed SDK.
// HTTP, navigation and the completion page's serialized POST receipt are fixtures.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
const externals = new Set(['react', 'next/navigation', 'next/link', '@/components/i18n/locale-provider', '@/lib/utils/cn']);
function collect(filename: string): string {
  const id = path.resolve(filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (externals.has(name)) { item.imports[name] = name; continue; }
    if (name === '@supabase/supabase-js') { item.imports[name] = 'sdk'; continue; }
    let target: string;
    if (name.startsWith('@/') || (name.startsWith('.') && /\.tsx?$/.test(id))) {
      const base = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(id), name);
      target = ['.ts', '.tsx'].map(extension => base + extension).find(file => fs.existsSync(file))!;
    } else target = require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries(['lib/supabase/client.ts', 'lib/auth/browser-signout.ts', 'lib/auth/browser-session-storage.ts',
  'lib/auth/cache-session.ts', 'components/auth/sign-out-form.tsx', 'components/auth/sign-out-completion.tsx'].map(file => [file, collect(file)]));
const ORIGIN = 'https://signout-flow-fixture.invalid';
const PROVIDER = 'https://signout-flow.supabase.co';
const KEY = 'sb-signout-flow-auth-token';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SIDA = '11111111-1111-4111-8111-111111111111';
const SIDB = '22222222-2222-4222-8222-222222222222';
type Probe = {
  signIn: (who: 'a' | 'b') => Promise<void>; refresh: () => Promise<void>;
  mount: (bridge?: SignOutBridge | null) => void; user: () => string | null;
  navigation: string[]; results: string[]; errors: string[];
  cacheUser: () => string | null;
};
declare global { interface Window { __signoutFlow: Probe } }

async function install(context: BrowserContext, outcome: number | 'network' = 204) {
  let release!: () => void;
  let logoutCalls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }); return; }
    if (url.origin !== PROVIDER) throw new Error(`Unexpected fixture origin ${url.origin}`);
    const headers = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/logout') {
      logoutCalls++;
      expect(url.searchParams.get('scope')).toBe('local');
      await held;
      if (outcome === 'network') { await route.abort('failed'); return; }
      await route.fulfill({ status: outcome, headers, ...(outcome === 204 ? {} : { contentType: 'application/json', body: '{"message":"Fixture refusal"}' }) });
      return;
    }
    if (url.pathname !== '/auth/v1/token') throw new Error(`Unexpected fixture request ${url.pathname}`);
    const body = route.request().postDataJSON() as { email?: string; refresh_token?: string };
    const who = body.email?.startsWith('b@') || body.refresh_token?.startsWith('b-') ? 'b' : 'a';
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const userId = who === 'a' ? A : B;
    const token = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, session_id: who === 'a' ? SIDA : SIDB, exp: expires, nonce: Math.random() })).toString('base64url')}.synthetic-signature`;
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ access_token: token, refresh_token: `${who}-synthetic-refresh`,
      token_type: 'bearer', expires_in: 3600, expires_at: expires,
      user: { id: userId, email: `${who}@fixture.invalid`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } }) });
  });
  return { release, logoutCalls: () => logoutCalls };
}

async function load(page: Page) {
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: sdk });
  const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, entries = ${JSON.stringify(entries)}, loaded = {}, messages = ${JSON.stringify(messages)};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(PROVIDER)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-key' } };
    const p = window.__signoutFlow = { navigation: [], results: [], errors: [] };
    const router = { replace: href => p.navigation.push(href), refresh() {} };
    const mocks = { sdk: window.supabase, react: React, 'next/navigation': { useRouter: () => router },
      'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
      '@/components/i18n/locale-provider': { useTranslations: () => key => messages[key] ?? key },
      '@/lib/utils/cn': { cn: (...args) => args.filter(value => typeof value === 'string').join(' ') } };
    function load(id) {
      if (id in mocks) return mocks[id];
      if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Missing module ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process);
      return module.exports;
    }
    const helper = load(entries['lib/auth/browser-signout.ts']), storage = load(entries['lib/auth/browser-session-storage.ts']);
    const original = helper.signOutBrowserSession;
    helper.signOutBrowserSession = (...args) => {
      const result = original(...args);
      result.revocation?.then(outcome => p.results.push(outcome));
      return result;
    };
    const db = load(entries['lib/supabase/client.ts']).createClient();
    const cache = load(entries['lib/auth/cache-session.ts']);
    cache.subscribeCacheSession(() => {});
    const Form = load(entries['components/auth/sign-out-form.tsx']).SignOutForm;
    const Completion = load(entries['components/auth/sign-out-completion.tsx']).SignOutCompletion;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    p.signIn = async who => { const result = await db.auth.signInWithPassword({ email: who + '@fixture.invalid', password: 'fixture-password' }); if(result.error) throw result.error; };
    p.refresh = async () => { const result = await db.auth.refreshSession(); if(result.error) throw result.error; };
    p.user = () => storage.captureBrowserSessionSnapshot()?.userId ?? null;
    p.cacheUser = () => cache.getCacheSessionSnapshot().identity?.userId ?? null;
    p.mount = (...args) => ReactDOM.flushSync(() => root.render(React.createElement(React.StrictMode, null, args.length
      ? React.createElement(Completion, { bridge: args[0] })
      : React.createElement(Form, null, ({ signingOut }) => React.createElement('button', { type: 'submit', disabled: signingOut }, 'Sign out')))));
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => p.errors.push(String(event.reason)));
  })();` });
}
const bridge = (): SignOutBridge => ({ nonce: '33333333-3333-4333-8333-333333333333', expiresAt: Date.now() + 60_000,
  intent: { kind: 'session', userId: A, sessionId: SIDA }, revocation: 'confirmed' });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

for (const outcome of [204, 503, 'network'] as const) {
  test(`a held logout ${outcome} cannot erase or navigate the later B login`, async ({ context, page }) => {
    const control = await install(context, outcome);
    await load(page);
    await page.evaluate(async () => { await window.__signoutFlow.signIn('a'); window.__signoutFlow.mount(); });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect(await page.evaluate(() => window.__signoutFlow.user())).toBeNull();
    await expect.poll(control.logoutCalls).toBe(1);
    const peer = await context.newPage();
    await load(peer);
    await peer.evaluate(() => window.__signoutFlow.signIn('b'));
    await expect.poll(() => page.evaluate(() => window.__signoutFlow.cacheUser())).toBe(B);
    const navigation = await page.evaluate(() => window.__signoutFlow.navigation);
    control.release();
    await expect.poll(() => page.evaluate(() => window.__signoutFlow.results)).toEqual([outcome === 204 ? 'confirmed' : 'unconfirmed']);
    expect(await page.evaluate(() => window.__signoutFlow.user())).toBe(B);
    expect(await page.evaluate(() => window.__signoutFlow.navigation)).toEqual(navigation);
    expect(await page.evaluate(() => window.__signoutFlow.errors)).toEqual([]);
  });
}
test('same-session renewal remains compatible with an already open sign-out form', async ({ context, page }) => {
  const control = await install(context); control.release();
  await load(page);
  await page.evaluate(async () => { await window.__signoutFlow.signIn('a'); window.__signoutFlow.mount(); await window.__signoutFlow.refresh(); });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect(await page.evaluate(() => window.__signoutFlow.user())).toBeNull();
  await expect.poll(control.logoutCalls).toBe(1);
});
test('a form opened for A refuses B before any cookie or provider mutation', async ({ context, page }) => {
  const control = await install(context);
  await load(page);
  await page.evaluate(async () => { await window.__signoutFlow.signIn('a'); window.__signoutFlow.mount(); await window.__signoutFlow.signIn('b'); });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect(await page.evaluate(() => window.__signoutFlow.user())).toBe(B);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(control.logoutCalls()).toBe(0);
  expect(await page.evaluate(() => window.__signoutFlow.navigation)).toEqual([]);
});
test('readable malformed cookies can still be explicitly signed out', async ({ context, page }) => {
  const control = await install(context);
  await load(page);
  await context.addCookies([{ name: KEY, value: 'malformed-session', url: ORIGIN }]);
  await page.evaluate(() => window.__signoutFlow.mount());
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await context.cookies()).some(cookie => cookie.name === KEY)).toBe(false);
  expect(control.logoutCalls()).toBe(0);
  expect(await page.evaluate(() => window.__signoutFlow.results)).toEqual(['unconfirmed']);
});
test('matching POST completion clears A once without revoking again', async ({ context, page }) => {
  const control = await install(context);
  await load(page);
  await page.evaluate(() => window.__signoutFlow.signIn('a'));
  await page.evaluate(receipt => window.__signoutFlow.mount(receipt), bridge());
  expect(await page.evaluate(() => window.__signoutFlow.user())).toBeNull();
  expect(control.logoutCalls()).toBe(0);
  expect(await page.evaluate(() => window.__signoutFlow.navigation)).toEqual(['/login']);
});
test('delayed POST completion for A preserves current B and offers explicit review', async ({ context, page }) => {
  const control = await install(context);
  await load(page);
  await page.evaluate(() => window.__signoutFlow.signIn('b'));
  await page.evaluate(receipt => window.__signoutFlow.mount(receipt), bridge());
  expect(await page.evaluate(() => window.__signoutFlow.user())).toBe(B);
  await expect(page.getByRole('status')).toBeVisible();
  expect(control.logoutCalls()).toBe(0);
  expect(await page.evaluate(() => window.__signoutFlow.navigation)).toEqual([]);
});
for (const label of ['missing', 'expired'] as const) {
  test(`${label} POST intent cannot automatically sign out the current browser`, async ({ context, page }) => {
    const control = await install(context);
    await load(page);
    await page.evaluate(() => window.__signoutFlow.signIn('a'));
    await page.evaluate(receipt => window.__signoutFlow.mount(receipt), label === 'missing' ? null : { ...bridge(), expiresAt: Date.now() - 1 });
    expect(await page.evaluate(() => window.__signoutFlow.user())).toBe(A);
    expect(control.logoutCalls()).toBe(0);
    expect(await page.evaluate(() => window.__signoutFlow.navigation)).toEqual([]);
  });
}
