import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { parsePkceInitiationRecord } from '../../lib/auth/pkce-initiation';

// Actual OAuthButtons, Locale/Toast providers, browser factory, cookie adapter
// and installed SDK. Only provider HTTP and named scheduling seams are controlled.
// An intercepted 204 records actual provider navigation without leaving the page.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const isolated = new Set(['react', 'lucide-react', '@/lib/utils/cn', '@capacitor/core', '@capacitor/haptics']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function sourceFile(filename: string) {
  return [filename, `${filename}.ts`, `${filename}.tsx`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? filename;
}
function collect(filename: string): string {
  const id = path.resolve(sourceFile(filename));
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = id.endsWith('.json') ? `module.exports = { default: ${JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw))
    .filter(([key]) => /^(oauthButtons\.|toast\.)/.test(key))))} };`
    : /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name) || name === '@supabase/supabase-js') { item.imports[name] = name; continue; }
    let target: string;
    if (name === '@supabase/ssr') target = require.resolve(name);
    else if (name.startsWith('@/')) target = path.resolve(name.slice(2));
    else if (name.startsWith('.') && /\.tsx?$/.test(id)) target = path.resolve(path.dirname(id), name);
    else target = require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries(['components/auth/oauth-buttons.tsx', 'components/ui/toast.tsx', 'components/i18n/locale-provider.tsx',
  'lib/supabase/client.ts', 'lib/auth/browser-signout.ts', 'lib/auth/password-client.ts', 'lib/auth/browser-session-storage.ts']
  .map(file => [file, collect(file)]));
entries.ssr = collect(require.resolve('@supabase/ssr'));
const origin = 'https://oauth-initiation-fixture.invalid';
const provider = 'https://oauth-initiation.supabase.co';
const key = 'sb-oauth-initiation-auth-token';
const users = { a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
type Barrier = 'write' | 'digest';
type Probe = {
  ready: boolean; errors: string[]; initiations: number; verifierWrites: number;
  pause: (kind: Barrier) => void; paused: () => boolean; release: () => void;
  capture: () => void; fire: (count?: number) => void; settle: () => Promise<void>; retire: () => void; changeNext: () => void;
  signIn: (who: 'a' | 'b') => Promise<void>; logout: () => string;
  cookies: () => string; sessionUser: () => string | null; verifier: () => string | null;
};
declare global { interface Window { __oauthInitiation: Probe } }
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

function session(who: 'a' | 'b') {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: users[who], session_id: who === 'a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', exp: expires })).toString('base64url'),
    'synthetic-signature'].join('.');
  return { access_token: token, refresh_token: `${who}-synthetic-refresh`, token_type: 'bearer', expires_in: 3600, expires_at: expires,
    user: { id: users[who], aud: 'authenticated', role: 'authenticated', email: `${who}@fixture.invalid`, app_metadata: {},
      user_metadata: {}, created_at: '2026-09-19T00:00:00Z' } };
}

async function fixture(page: Page) {
  const authorizations: URL[] = [];
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }); return; }
    if (url.origin !== provider) throw new Error('Unexpected OAuth fixture destination.');
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/authorize' && request.isNavigationRequest()) {
      authorizations.push(url); await route.fulfill({ status: 204 }); return;
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const who = (request.postDataJSON() as { email?: string }).email?.startsWith('b@') ? 'b' : 'a';
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(session(who)) }); return;
    }
    if (url.pathname === '/auth/v1/user') {
      const claims = JSON.parse(Buffer.from(request.headers().authorization!.slice(7).split('.')[1], 'base64url').toString());
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(session(claims.sub === users.b ? 'b' : 'a').user) }); return;
    }
    throw new Error('Unexpected OAuth fixture request.');
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')))
    .filter(([name]) => /^(oauthButtons\.|toast\.)/.test(name)));
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, entries = ${JSON.stringify(entries)}, loaded = {}, messages = ${JSON.stringify(messages)};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-key' } };
    const key = ${JSON.stringify(key)}, p = window.__oauthInitiation = { ready: false, errors: [], initiations: 0, verifierWrites: 0 };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    let barrier = null, paused = false, release, captured, root, show = true, next = '/dashboard/meals', jobs = [];
    async function hold(kind) { if (barrier === kind) { barrier = null; paused = true; await new Promise(resolve => { release = resolve; }); } }
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      // Pause the SDK's challenge after its verifier write, not earlier witness hashing.
      if (p.initiations > 0 && p.verifierWrites > 0) await hold('digest');
      return digest(...args);
    };
    const mocks = { react: React, '@supabase/supabase-js': window.supabase,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
      '@capacitor/core': { Capacitor: { isNativePlatform: () => false } }, '@capacitor/haptics': {},
    };
    function load(id) {
      if (id in mocks) return mocks[id]; if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected OAuth fixture module: ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process);
      if (id === entries.ssr) {
        const actual = module.exports;
        module.exports = { ...actual, createBrowserClient: (...args) => {
          const options = args[2];
          if (options?.cookies?.setAll) {
            const write = options.cookies.setAll;
            options.cookies.setAll = async cookies => {
              const verifier = cookies.some(cookie => actual.isChunkLike(cookie.name, key + '-code-verifier') && cookie.options.maxAge !== 0);
              if (verifier) await hold('write');
              await write(cookies); if (verifier) p.verifierWrites++;
            };
          }
          const client = actual.createBrowserClient(...args), oauth = client.auth.signInWithOAuth.bind(client.auth);
          client.auth.signInWithOAuth = (...values) => { p.initiations++; return oauth(...values); };
          return client;
        } };
      }
      return module.exports;
    }
    const ssr = load(entries.ssr), OAuthButtons = load(entries['components/auth/oauth-buttons.tsx']).OAuthButtons;
    const ToastProvider = load(entries['components/ui/toast.tsx']).ToastProvider;
    const LocaleProvider = load(entries['components/i18n/locale-provider.tsx']).LocaleProvider;
    const db = load(entries['lib/supabase/client.ts']).createClient();
    const logout = load(entries['lib/auth/browser-signout.ts']);
    const password = load(entries['lib/auth/password-client.ts']);
    const storage = load(entries['lib/auth/browser-session-storage.ts']);
    function render() {
      root ??= ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(LocaleProvider, { locale: 'en-US', source: 'default', messages },
        React.createElement(ToastProvider, null, show ? React.createElement(OAuthButtons, { next }) : React.createElement('p', null, 'Other route')))));
    }
    p.pause = kind => { barrier = kind; paused = false; }; p.paused = () => paused;
    p.release = () => { release?.(); release = undefined; };
    p.capture = () => { const button = document.querySelector('button'); captured = button[Object.keys(button).find(name => name.startsWith('__reactProps$'))].onClick; };
    p.fire = (count = 1) => { for (let index = 0; index < count; index++) jobs.push(Promise.resolve(captured()).catch(error => p.errors.push(String(error)))); };
    p.settle = async () => { await Promise.all(jobs); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
    p.retire = () => { show = false; render(); };
    p.changeNext = () => { next = '/onboarding'; render(); };
    p.signIn = async who => { const result = await password.signInWithOwnedSession({ email: who + '@fixture.invalid', password: 'synthetic-password' }, () => true); if (result.error) throw result.error; };
    p.logout = () => logout.signOutBrowserSession(logout.captureSignOutIntent(), { revoke: false }).status;
    p.cookies = () => JSON.stringify(ssr.parseCookieHeader(document.cookie).filter(cookie => cookie.name.startsWith(key)).sort((a, b) => a.name.localeCompare(b.name)));
    p.sessionUser = () => storage.captureBrowserSessionSnapshot()?.userId ?? null;
    p.verifier = () => {
      const parts = ssr.parseCookieHeader(document.cookie).filter(cookie => ssr.isChunkLike(cookie.name, key + '-code-verifier')).sort((a, b) => a.name.localeCompare(b.name));
      if (!parts.length) return null;
      const value = parts.map(part => part.value).join(''); return JSON.parse(value.startsWith('base64-') ? ssr.stringFromBase64URL(value.slice(7)) : value);
    };
    render();
    db.auth.getSession().then(() => db.auth.stopAutoRefresh()).then(() => { p.ready = true; });
  })();` });
  await expect.poll(() => page.evaluate(() => window.__oauthInitiation.ready)).toBe(true);
  return { authorizations };
}

test('ordinary Google initiation publishes the matching verifier and preserves safe destination/offline access', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await expect.poll(() => state.authorizations.length).toBe(1);
  const url = state.authorizations[0], callback = new URL(url.searchParams.get('redirect_to')!);
  expect(url.searchParams.get('provider')).toBe('google');
  expect(url.searchParams.get('access_type')).toBe('offline'); expect(url.searchParams.get('prompt')).toBe('consent');
  expect(url.searchParams.get('code_challenge_method')).toBe('s256');
  expect(callback.origin).toBe(origin); expect(callback.pathname).toBe('/auth/callback');
  expect(callback.searchParams.get('next')).toBe('/dashboard/meals');
  const verifier = await page.evaluate(() => window.__oauthInitiation.verifier());
  expect(typeof verifier === 'string' && createHash('sha256').update(verifier).digest('base64url') === url.searchParams.get('code_challenge')).toBe(true);
  const cookies: Array<{ name: string; value: string }> = JSON.parse(await page.evaluate(() => window.__oauthInitiation.cookies()));
  const record = parsePkceInitiationRecord(cookies.find(cookie => cookie.name === `${key}-pkce-initiation`)?.value);
  expect(record).toMatchObject({ kind: 'oauth', nonce: callback.searchParams.get('attempt') });
  expect(await page.evaluate(() => ({ initiations: window.__oauthInitiation.initiations, writes: window.__oauthInitiation.verifierWrites, errors: window.__oauthInitiation.errors })))
    .toEqual({ initiations: 1, writes: 1, errors: [] });
});

for (const barrier of ['write', 'digest'] as const) for (const change of ['logout', 'newer-login', 'unmount', 'next-intent'] as const) {
  test(`held OAuth ${barrier} cannot continue after ${change}`, async ({ page }) => {
    const state = await fixture(page);
    await page.evaluate(async barrier => {
      const p = window.__oauthInitiation; await p.signIn('a'); p.pause(barrier); p.capture(); p.fire();
    }, barrier);
    await expect.poll(() => page.evaluate(() => window.__oauthInitiation.paused())).toBe(true);
    await page.evaluate(async change => {
      const p = window.__oauthInitiation;
      if (change === 'logout') { if (p.logout() !== 'signed-out') throw new Error('Fixture production logout failed'); }
      else if (change === 'newer-login') await p.signIn('b');
      else if (change === 'next-intent') p.changeNext();
      else p.retire();
    }, change);
    const before = await page.evaluate(() => ({ cookies: window.__oauthInitiation.cookies(), writes: window.__oauthInitiation.verifierWrites }));
    await page.evaluate(async () => { window.__oauthInitiation.release(); await window.__oauthInitiation.settle(); });
    const after = await page.evaluate(() => ({ cookies: window.__oauthInitiation.cookies(), writes: window.__oauthInitiation.verifierWrites,
      user: window.__oauthInitiation.sessionUser(), errors: window.__oauthInitiation.errors }));
    expect.soft(state.authorizations.length, 'Retired initiation must not navigate to the provider').toBe(0);
    expect.soft(after.writes, 'Retired initiation must not publish a late verifier').toBe(before.writes);
    if ((change !== 'unmount' && change !== 'next-intent') || barrier === 'write') expect.soft(after.cookies === before.cookies, 'Late work must preserve the current cookie owner').toBe(true);
    expect.soft(after.user).toBe(change === 'logout' ? null : change === 'newer-login' ? users.b : users.a);
    await expect(page.getByText('Sign-in changed before it could be completed. Please try again.', { exact: true })).toHaveCount(0);
    expect(after.errors).toEqual([]);
  });
}

test('same-turn duplicate Google handlers dispatch only one owned initiation', async ({ page }) => {
  const state = await fixture(page);
  await page.evaluate(() => { const p = window.__oauthInitiation; p.pause('write'); p.capture(); p.fire(2); });
  await expect.poll(() => page.evaluate(() => window.__oauthInitiation.paused())).toBe(true);
  await page.evaluate(async () => { window.__oauthInitiation.release(); await window.__oauthInitiation.settle(); });
  expect.soft(await page.evaluate(() => window.__oauthInitiation.initiations)).toBe(1);
  expect.soft(await page.evaluate(() => window.__oauthInitiation.verifierWrites)).toBe(1);
  expect.soft(state.authorizations.length).toBe(1);
  expect(await page.evaluate(() => window.__oauthInitiation.errors)).toEqual([]);
});

test('a newer tab claims OAuth before either verifier write so releasing the older attempt first cannot navigate', async ({ context, page }) => {
  const older = await fixture(page);
  const newerPage = await context.newPage();
  const newer = await fixture(newerPage);
  const start = (target: Page) => target.evaluate(() => {
    const p = window.__oauthInitiation;
    p.pause('write'); p.capture(); p.fire();
    // Read in the initiating task, before the SDK's first asynchronous continuation.
    const cookies: Array<{ name: string; value: string }> = JSON.parse(p.cookies());
    return { claim: cookies.find(cookie => cookie.name.endsWith('-auth-token-pkce-initiation'))?.value ?? null,
      hasVerifier: p.verifier() !== null };
  });
  const first = await start(page);
  await expect.poll(() => page.evaluate(() => window.__oauthInitiation.paused())).toBe(true);
  const second = await start(newerPage);
  await expect.poll(() => newerPage.evaluate(() => window.__oauthInitiation.paused())).toBe(true);
  expect.soft(typeof first.claim === 'string' && /^pending-v1-[a-f0-9]{32}$/.test(first.claim), 'First intent is reserved synchronously').toBe(true);
  expect.soft(typeof second.claim === 'string' && /^pending-v1-[a-f0-9]{32}$/.test(second.claim)
    && second.claim !== first.claim, 'Newer intent replaces the reservation before any verifier write').toBe(true);
  expect.soft(first.hasVerifier || second.hasVerifier).toBe(false);

  await page.evaluate(async () => { window.__oauthInitiation.release(); await window.__oauthInitiation.settle(); });
  expect.soft(older.authorizations.length, 'The superseded older tab must not navigate even when it settles first').toBe(0);
  expect.soft(await page.evaluate(() => window.__oauthInitiation.verifierWrites), 'The superseded older tab must not publish a verifier').toBe(0);

  await newerPage.evaluate(async () => { window.__oauthInitiation.release(); await window.__oauthInitiation.settle(); });
  expect.soft(newer.authorizations.length, 'The newest intent alone reaches the provider').toBe(1);
  expect.soft(await newerPage.evaluate(() => window.__oauthInitiation.verifierWrites)).toBe(1);
  const cookies: Array<{ name: string; value: string }> = JSON.parse(await newerPage.evaluate(() => window.__oauthInitiation.cookies()));
  const record = parsePkceInitiationRecord(cookies.find(cookie => cookie.name === `${key}-pkce-initiation`)?.value);
  expect.soft(record?.kind).toBe('oauth');
  expect.soft(record?.nonce === second.claim?.slice('pending-v1-'.length), 'Completed record belongs to the later synchronous reservation').toBe(true);
  if (newer.authorizations[0]) {
    const callback = new URL(newer.authorizations[0].searchParams.get('redirect_to')!);
    expect(callback.searchParams.get('attempt')).toBe(record?.nonce);
  }
  expect(await page.evaluate(() => window.__oauthInitiation.errors)).toEqual([]);
  expect(await newerPage.evaluate(() => window.__oauthInitiation.errors)).toEqual([]);
});
