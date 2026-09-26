import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Actual password/child-token/signup ownership helpers, OAuthButtons, browser
// storage and installed SDK. Only provider HTTP and scheduling seams are held.
// Intercepted OAuth navigation records dispatch without leaving the fixture.
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
  'lib/auth/pkce-initiation-client.ts', 'lib/supabase/client.ts', 'lib/auth/browser-signout.ts', 'lib/auth/password-client.ts', 'lib/auth/browser-session-storage.ts']
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
  child: (tokens: { access_token: string; refresh_token: string }, canCommit?: boolean) => Promise<boolean>;
  signup: () => Promise<void>; signIn: (who: 'a' | 'b', canCommit?: boolean) => Promise<void>; logout: () => string;
  cookies: () => string; sessionUser: () => string | null; verifier: () => string | null;
};
declare global { interface Window { __authInitiationOrder: Probe } }
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

async function fixture(page: Page, pathname = '') {
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
  await page.goto(origin + pathname);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')))
    .filter(([name]) => /^(oauthButtons\.|toast\.)/.test(name)));
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, entries = ${JSON.stringify(entries)}, loaded = {}, messages = ${JSON.stringify(messages)};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-key' } };
    const key = ${JSON.stringify(key)}, p = window.__authInitiationOrder = { ready: false, errors: [], initiations: 0, verifierWrites: 0 };
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
    p.child = async (tokens, canCommit = true) => { try { const result = await password.signInWithOwnedSessionTokens(async () => tokens, () => canCommit); return !result.error && !!result.data.session; } catch { return false; } };
    p.signup = async () => { const result = await load(entries['lib/auth/pkce-initiation-client.ts']).signUpWithInitiation({ email: 'new@fixture.invalid', password: 'synthetic-password' }, () => true); if (result.error) throw result.error; };
    p.signIn = async (who, canCommit = true) => { const result = await password.signInWithOwnedSession({ email: who + '@fixture.invalid', password: 'synthetic-password' }, () => canCommit); if (result.error) throw result.error; };
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
  await expect.poll(() => page.evaluate(() => window.__authInitiationOrder.ready)).toBe(true);
  return { authorizations };
}

for (const kind of ['oauth', 'signup'] as const) for (const first of ['password', 'initiation'] as const) {
  test(`newer decision owns cross-flow ${first} first versus ${kind}`, async ({ page }) => {
    const state = await fixture(page);
    await page.evaluate(() => window.__authInitiationOrder.signIn('a'));
    let passwordStarted = false, releasePassword = () => {};
    const gate = new Promise<void>(resolve => { releasePassword = resolve; });
    let signupRequests = 0;
    await page.route(url => url.origin === provider && url.pathname === '/auth/v1/signup', async route => {
      const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
      signupRequests++;
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(session('a').user) });
    });
    await page.route(url => url.origin === provider && url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password', async route => {
      if (route.request().method() !== 'OPTIONS') { passwordStarted = true; await gate; }
      await route.fallback();
    });
    let signingIn!: Promise<boolean>, initiating!: Promise<boolean>;
    const startPassword = async () => {
      signingIn = page.evaluate(() => window.__authInitiationOrder.signIn('b').then(() => true, () => false));
      await expect.poll(() => passwordStarted).toBe(true);
    };
    const startInitiation = async () => {
      await page.evaluate(() => window.__authInitiationOrder.pause('write'));
      if (kind === 'oauth') {
        await page.evaluate(() => { window.__authInitiationOrder.capture(); window.__authInitiationOrder.fire(); });
        initiating = page.evaluate(() => window.__authInitiationOrder.settle().then(() => true, () => false));
      } else initiating = page.evaluate(() => window.__authInitiationOrder.signup().then(() => true, () => false));
      await expect.poll(() => page.evaluate(() => window.__authInitiationOrder.paused())).toBe(true);
    };
    try {
      if (first === 'password') { await startPassword(); await startInitiation(); }
      else { await startInitiation(); await startPassword(); }
      if (first === 'password') {
        releasePassword();
        expect.soft(await signingIn, 'Older password response must refuse adoption after newer initiation reservation').toBe(false);
        expect.soft(await page.evaluate(() => window.__authInitiationOrder.sessionUser()), 'Original A should survive while newer initiation owns pending choice').toBe(users.a);
        await page.evaluate(() => window.__authInitiationOrder.release()); await initiating;
        expect.soft(kind === 'oauth' ? state.authorizations.length : signupRequests, 'Newer initiation should remain usable').toBe(1);
      } else {
        await page.evaluate(() => window.__authInitiationOrder.release()); await initiating;
        expect.soft(kind === 'oauth' ? state.authorizations.length : signupRequests, 'Older initiation should not dispatch after a newer password decision').toBe(0);
        releasePassword();
        expect.soft(await signingIn, 'Newer password response remains usable').toBe(true);
        expect.soft(await page.evaluate(() => window.__authInitiationOrder.sessionUser())).toBe(users.b);
      }
    } finally { releasePassword(); await page.evaluate(() => window.__authInitiationOrder.release()).catch(() => {}); }
  });
}

for (const kind of ['password', 'child-token'] as const) test(`ordinary ${kind} login reserves its decision and preserves the existing verifier`, async ({ page, context }) => {
  await fixture(page);
  await context.addCookies([{ name: `${key}-code-verifier`, value: 'unconsumed-verifier', url: origin }]);
  const before = (await context.cookies(origin)).find(cookie => cookie.name === `${key}-code-verifier`)!.value;
  if (kind === 'password') await page.evaluate(() => window.__authInitiationOrder.signIn('b'));
  else expect(await page.evaluate(tokens => window.__authInitiationOrder.child(tokens), session('b'))).toBe(true);
  expect(await page.evaluate(() => window.__authInitiationOrder.sessionUser())).toBe(users.b);
  const after = await context.cookies(origin);
  expect(after.find(cookie => cookie.name === `${key}-code-verifier`)?.value).toBe(before);
  expect(after.find(cookie => cookie.name === `${key}-pkce-initiation`)?.value).toMatch(/^session-v1-[a-f0-9]{32}$/);
});

test('newer pending password retires the older password even when its response arrives first', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => window.__authInitiationOrder.signIn('a'));
  const entered: string[] = [];
  let releaseA = () => {}, releaseB = () => {};
  const gates = { a: new Promise<void>(resolve => { releaseA = resolve; }), b: new Promise<void>(resolve => { releaseB = resolve; }) };
  await page.route(url => url.origin === provider && url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password', async route => {
    if (route.request().method() !== 'OPTIONS') {
      const who = route.request().postDataJSON().email.startsWith('b@') ? 'b' : 'a';
      entered.push(who); await gates[who];
    }
    await route.fallback();
  });
  try {
    const older = page.evaluate(() => window.__authInitiationOrder.signIn('a').then(() => true, () => false));
    await expect.poll(() => entered.join(',')).toBe('a');
    const newer = page.evaluate(() => window.__authInitiationOrder.signIn('b').then(() => true, () => false));
    await expect.poll(() => entered.join(',')).toBe('a,b');
    releaseA(); expect(await older).toBe(false);
    expect(await page.evaluate(() => window.__authInitiationOrder.sessionUser())).toBe(users.a);
    releaseB(); expect(await newer).toBe(true);
    expect(await page.evaluate(() => window.__authInitiationOrder.sessionUser())).toBe(users.b);
  } finally { releaseA(); releaseB(); }
});

for (const barrier of ['refused', 'duplicate', 'chunked'] as const) test(`${barrier} decision storage refuses password and child dispatch while preserving the current session`, async ({ page, context }) => {
  await fixture(page, barrier === 'duplicate' ? '/auth/complete' : ''); await page.evaluate(() => window.__authInitiationOrder.signIn('a'));
  const before = (await context.cookies(origin)).filter(cookie => cookie.name === key || cookie.name.startsWith(`${key}.`))
    .map(({ name, value }) => ({ name, value }));
  if (barrier === 'refused') {
    await page.evaluate(name => {
      const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
      Object.defineProperty(document, 'cookie', { configurable: true, get: () => cookie.get!.call(document),
        set: value => { if (!String(value).startsWith(`${name}=`)) cookie.set!.call(document, value); } });
    }, `${key}-pkce-initiation`);
  } else {
    await context.addCookies([{ name: `${key}-pkce-initiation${barrier === 'chunked' ? '.0' : ''}`, value: 'ambiguous-marker',
      domain: new URL(origin).hostname, path: barrier === 'duplicate' ? '/auth' : '/', secure: true }]);
    if (barrier === 'duplicate') expect(await page.evaluate(name => document.cookie.split(';').filter(part => part.trim().startsWith(`${name}=`)).length,
      `${key}-pkce-initiation`), 'Both real cookie paths must be visible to the SDK').toBe(2);
  }
  let requests = 0;
  const observe = (request: { url(): string }) => { if (new URL(request.url()).origin === provider) requests++; };
  page.on('request', observe);
  expect(await page.evaluate(() => window.__authInitiationOrder.signIn('b').then(() => true, () => false))).toBe(false);
  expect(await page.evaluate(tokens => window.__authInitiationOrder.child(tokens), session('b'))).toBe(false);
  expect(requests, 'A decision whose ownership cannot be stored must not reach the provider').toBe(0);
  expect((await context.cookies(origin)).filter(cookie => cookie.name === key || cookie.name.startsWith(`${key}.`))
    .map(({ name, value }) => ({ name, value }))).toEqual(before);
  expect(await page.evaluate(() => window.__authInitiationOrder.sessionUser())).toBe(users.a);
});

test('retired password and child callbacks cannot claim a marker or dispatch', async ({ page }) => {
  await fixture(page); await page.evaluate(() => window.__authInitiationOrder.signIn('a'));
  const before = await page.evaluate(() => window.__authInitiationOrder.cookies());
  let requests = 0;
  page.on('request', request => { if (new URL(request.url()).origin === provider) requests++; });
  expect(await page.evaluate(() => window.__authInitiationOrder.signIn('b', false).then(() => true, () => false))).toBe(false);
  expect(await page.evaluate(tokens => window.__authInitiationOrder.child(tokens, false), session('b'))).toBe(false);
  expect(requests).toBe(0);
  expect(await page.evaluate(() => window.__authInitiationOrder.cookies()) === before, 'Retired callbacks preserve every auth cookie byte').toBe(true);
});
