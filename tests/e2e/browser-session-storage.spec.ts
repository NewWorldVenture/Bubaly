import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Production browser factory + installed SSR cookie adapter + installed auth SDK.
// Only the provider HTTP response is synthetic. No real account, provider or
// environment secret is used. The process-restart test owns a disposable browser
// profile containing only synthetic cookies; other contexts transfer in memory.
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
const origin = 'https://browser-session-fixture.invalid';
const provider = 'https://session-fixture.supabase.co';
type SessionProbe = { signIn: () => Promise<string | null>; user: () => Promise<string | null>; signOut: () => Promise<void>; singleton: () => boolean };
declare global { interface Window { __browserSession: SessionProbe } }

async function install(context: BrowserContext, refresh?: () => 'incomplete' | 'normal') {
  const calls: string[] = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Controlled session fixture</body></html>' });
      return;
    }
    if (url.origin !== provider) throw new Error(`Unexpected fixture destination: ${url.origin}`);
    calls.push(`${route.request().method()} ${url.pathname}`);
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (route.request().method() === 'OPTIONS' || url.pathname === '/auth/v1/logout') {
      await route.fulfill({ status: 204, headers }); return;
    }
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const jwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', session_id: '11111111-1111-4111-8111-111111111111', exp: expires, aud: 'authenticated' })).toString('base64url'),
      'synthetic-signature',
    ].join('.');
    const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' };
    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'refresh_token' && refresh?.() === 'incomplete') {
        await route.fulfill({ contentType: 'application/json', headers, body: '{}' }); return;
      }
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ access_token: jwt, refresh_token: 'synthetic-refresh-fixture', token_type: 'bearer', expires_in: 3600, expires_at: expires, user }) }); return;
    }
    if (url.pathname === '/auth/v1/user') {
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(user) }); return;
    }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  });
  return calls;
}

async function load(page: Page) {
  await page.goto(origin);
  await page.addScriptTag({ content: sdk });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, loaded = {};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-fixture' } };
    function load(id) {
      if (id === 'sdk') return window.supabase;
      if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module: ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process);
      return module.exports;
    }
    const { createClient } = load(${JSON.stringify(entry)});
    window.__browserSession = {
      singleton: () => createClient() === createClient(),
      signIn: async () => { const { data, error } = await createClient().auth.signInWithPassword({ email: 'fixture@example.invalid', password: 'synthetic-password' }); if (error) throw error; return data.session?.user.id ?? null; },
      user: async () => { const { data, error } = await createClient().auth.getSession(); if (error) throw error; return data.session?.user.id ?? null; },
      signOut: async () => { const { error } = await createClient().auth.signOut({ scope: 'local' }); if (error) throw error; },
    };
  })();` });
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('persistent cookies survive an actual browser-process restart until local sign-out', async ({ playwright, browserName }, testInfo) => {
  const profile = testInfo.outputPath('synthetic-session-profile');
  const options = { headless: true, ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}) };
  const first = await playwright[browserName].launchPersistentContext(profile, options);
  try {
    await install(first);
    const page = await first.newPage(); await load(page);
    await page.evaluate(() => window.__browserSession.signIn());
  } finally { await first.close(); }
  const second = await playwright[browserName].launchPersistentContext(profile, options);
  try {
    const calls = await install(second);
    const page = await second.newPage(); await load(page);
    expect(await page.evaluate(() => window.__browserSession.user())).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(calls.filter(call => call.includes('/auth/v1/token'))).toEqual([]);
    await page.evaluate(() => window.__browserSession.signOut());
  } finally { await second.close(); }
  const third = await playwright[browserName].launchPersistentContext(profile, options);
  try {
    await install(third);
    const page = await third.newPage(); await load(page);
    expect(await page.evaluate(() => window.__browserSession.user())).toBeNull();
  } finally { await third.close(); }
});

test('an expired session survives an incomplete renewal and recovers after reopening', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    let mode: 'incomplete' | 'normal' = 'normal';
    await install(context, () => mode);
    const page = await context.newPage(); await load(page);
    await page.evaluate(() => window.__browserSession.signIn());
    await page.close();
    const cookies = (await context.cookies(origin)).filter(cookie => /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name));
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0];
    const saved = JSON.parse(Buffer.from(cookie.value.slice('base64-'.length), 'base64url').toString('utf8'));
    saved.expires_at = Math.floor(Date.now() / 1000) - 3600;
    cookie.value = `base64-${Buffer.from(JSON.stringify(saved)).toString('base64url')}`;
    await context.addCookies([cookie]);
    mode = 'incomplete';
    const returning = await context.newPage();
    await returning.clock.install();
    await load(returning);
    const read = returning.evaluate(async () => {
      try { await window.__browserSession.user(); return 'unexpected success'; }
      catch (error) { return error instanceof Error ? error.name : 'unknown failure'; }
    });
    await returning.clock.runFor(40_000);
    expect(await read).toBe('AuthRetryableFetchError');
    expect((await context.cookies(origin)).some(item => item.name === cookie.name && item.value === cookie.value)).toBe(true);
    await returning.close();
    mode = 'normal';
    const recovered = await context.newPage(); await load(recovered);
    expect(await recovered.evaluate(() => window.__browserSession.user())).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await recovered.evaluate(() => window.__browserSession.signOut());
    expect((await context.cookies(origin)).some(item => /^sb-.+-auth-token(?:\.\d+)?$/.test(item.name))).toBe(false);
  } finally { await context.close(); }
});

test('production browser client persists durable secure cookies and restores with cookies alone', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    await install(first);
    const page = await first.newPage(); await load(page);
    expect(await page.evaluate(() => window.__browserSession.singleton())).toBe(true);
    expect(await page.evaluate(() => window.__browserSession.signIn())).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const cookies = (await first.cookies(origin)).filter(cookie => /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name));
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).toMatchObject({ path: '/', secure: true, sameSite: 'Lax' });
      expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 390 * 86400);
    }
    await second.addCookies(cookies);
    await first.close();
    const calls = await install(second);
    const restored = await second.newPage(); await load(restored);
    expect(await restored.evaluate(() => localStorage.length)).toBe(0);
    expect(await restored.evaluate(() => window.__browserSession.user())).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(calls.filter(call => call.includes('/auth/v1/token'))).toEqual([]);
  } finally { await first.close(); await second.close(); }
});

test('local SDK sign-out removes saved auth cookies and a fresh context remains signed out', async ({ browser }) => {
  const context = await browser.newContext();
  const restoredContext = await browser.newContext();
  try {
    await install(context);
    const page = await context.newPage(); await load(page);
    await page.evaluate(() => window.__browserSession.signIn());
    await page.evaluate(() => window.__browserSession.signOut());
    expect(await page.evaluate(() => window.__browserSession.user())).toBeNull();
    const cookies = await context.cookies(origin);
    expect(cookies.some(cookie => /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name))).toBe(false);
    await restoredContext.addCookies(cookies);
    await install(restoredContext);
    const restored = await restoredContext.newPage(); await load(restored);
    expect(await restored.evaluate(() => window.__browserSession.user())).toBeNull();
  } finally { await context.close(); await restoredContext.close(); }
});
