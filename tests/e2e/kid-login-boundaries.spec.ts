import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Real KidLoginForm, guarded adoption helper, SSR adapter and auth SDK.
// The server-action transport and provider HTTP are controlled separately from
// tests/child-login-session-adoption.test.ts, which executes the real action.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const isolated = new Set(['react', 'lucide-react', 'next/link', 'next/navigation', '@/components/ui/toast', '@/components/i18n/locale-provider', '@/app/(auth)/actions', '@/lib/utils/cn']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function sourceFile(filename: string) {
  return [filename, `${filename}.ts`, `${filename}.tsx`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? filename;
}
function collect(filename: string): string {
  const id = path.resolve(sourceFile(filename));
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name) || name === '@supabase/supabase-js') { item.imports[name] = name; continue; }
    let target: string;
    if (name.startsWith('@/')) target = path.resolve(name.slice(2));
    else if (name.startsWith('.') && /\.tsx?$/.test(id)) target = path.resolve(path.dirname(id), name);
    else target = require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries(['components/auth/kid-login-form.tsx', 'lib/supabase/client.ts', 'lib/auth/browser-session-storage.ts'].map(file => [file, collect(file)]));
const origin = 'https://kid-login-fixture.invalid';
const provider = 'https://kid-provider.invalid';
const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type ActionMode = 'success' | 'hold' | 'reject' | 'throw' | 'malformed';
type Probe = {
  mode: ActionMode; calls: Array<{ username: string; pin: string }>; toasts: string[]; errors: string[]; navigations: string[]; links: string[];
  refreshes: number; pending: number; mount: () => void; retire: () => void; captureSubmit: () => void; fireCaptured: (count?: number) => void;
  release: () => void; settle: () => Promise<void>; currentUser: () => string | null; signInB: () => Promise<void>; logout: () => void; failWrites: () => void;
};
declare global { interface Window { __kidLogin: Probe } }
type Fixture = { requests: string[]; rejectVerification: boolean };
function user(id: string) {
  return { id, email: id === userA ? 'child.emma@kids.bubaly.app' : 'b@example.invalid', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' };
}
function session(id: string) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const jwt = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: id, session_id: id === userA ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', exp: expires, aud: 'authenticated' })).toString('base64url'), 'synthetic-signature'].join('.');
  return { access_token: jwt, refresh_token: `synthetic-refresh-${id}`, expires_at: expires, expires_in: 3600, token_type: 'bearer', user: user(id) };
}
async function fixture(page: Page, mode: ActionMode = 'success', locale = 'en-US'): Promise<Fixture> {
  const state: Fixture = { requests: [], rejectVerification: false };
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }); return; }
    if (url.origin !== provider) throw new Error(`Unexpected fixture destination: ${url.origin}`);
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    state.requests.push(`${route.request().method()} ${url.pathname}`);
    if (url.pathname === '/auth/v1/token') {
      await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(session(userB)) }); return;
    }
    if (url.pathname === '/auth/v1/user') {
      const auth = route.request().headers().authorization?.slice(7) ?? '';
      const id = JSON.parse(Buffer.from(auth.split('.')[1], 'base64url').toString()).sub;
      await route.fulfill({ headers, status: state.rejectVerification ? 401 : 200, contentType: 'application/json',
        body: JSON.stringify(state.rejectVerification ? { msg: 'Synthetic token rejection' } : user(id)) }); return;
    }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')))
    .filter(([key]) => /^(kidLogin\.|actions\.)/.test(key)));
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, entries = ${JSON.stringify(entries)}, loaded = {}, messages = ${JSON.stringify(messages)};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon' } };
    const p = window.__kidLogin = { mode: ${JSON.stringify(mode)}, calls: [], toasts: [], errors: [], navigations: [], links: [], refreshes: 0, pending: 0 };
    let root, captured, jobs = [], releases = [];
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    const router = { push: path => p.navigations.push(path), refresh: () => { p.refreshes++; } };
    const mocks = {
      react: React, '@supabase/supabase-js': window.supabase, 'lucide-react': new Proxy({}, { get: () => () => null }),
      'next/navigation': { useRouter: () => router },
      'next/link': { default: ({ children, ...props }) => React.createElement('a', { ...props, onClick: event => { props.onClick?.(event); event.preventDefault(); p.links.push(props.href); } }, children) },
      '@/components/i18n/locale-provider': { useTranslations: () => key => messages[key] ?? key },
      '@/components/ui/toast': { useToast: () => ({ error: message => p.toasts.push(message) }) },
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
      '@/app/(auth)/actions': { childSignInAction: async input => {
        p.calls.push(input);
        const mode = p.mode;
        if (mode === 'hold') await new Promise(resolve => releases.push(resolve));
        if (mode === 'reject') return { ok: false, error: messages['actions.thatUsernameOrPinIsn'] };
        if (mode === 'throw') throw new Error('Synthetic private framework diagnostic');
        if (mode === 'malformed') return { ok: true, tokens: { access_token: 'malformed', refresh_token: 'malformed' } };
        return { ok: true, tokens: ${JSON.stringify({ access_token: session(userA).access_token, refresh_token: session(userA).refresh_token })} };
      } },
    };
    function load(id) {
      if (id in mocks) return mocks[id];
      if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module: ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process);
      return module.exports;
    }
    const Form = load(entries['components/auth/kid-login-form.tsx']).KidLoginForm;
    const db = load(entries['lib/supabase/client.ts']).createClient();
    const storage = load(entries['lib/auth/browser-session-storage.ts']);
    p.mount = () => { root ??= ReactDOM.createRoot(document.getElementById('root')); ReactDOM.flushSync(() => root.render(React.createElement(Form))); };
    p.retire = () => ReactDOM.flushSync(() => root.render(null));
    p.captureSubmit = () => {
      const form = document.querySelector('form');
      const props = form[Object.keys(form).find(key => key.startsWith('__reactProps'))];
      captured = () => props.onSubmit({ preventDefault() {}, currentTarget: form });
    };
    p.fireCaptured = (count = 1) => { for (let i = 0; i < count; i++) { p.pending++; jobs.push(Promise.resolve(captured()).finally(() => p.pending--)); } };
    p.release = () => { for (const release of releases.splice(0)) release(); };
    p.settle = async () => { await Promise.all(jobs); jobs = []; };
    p.currentUser = () => storage.captureBrowserSessionSnapshot()?.userId ?? null;
    p.signInB = async () => { const { error } = await db.auth.signInWithPassword({ email: 'b@example.invalid', password: 'synthetic-password' }); if (error) throw error; };
    p.logout = () => { if (!storage.clearBrowserSessionSnapshot(storage.captureBrowserSessionSnapshot())) throw new Error('Logout ownership changed'); };
    p.failWrites = () => { const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie'); Object.defineProperty(document, 'cookie', { configurable: true, get: () => descriptor.get.call(document), set: () => {} }); };
    p.mount();
  })();` });
  return state;
}
async function fill(page: Page, username = ' EmMa ', pin = '1234') {
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="pin"]').fill(pin);
}
async function submit(page: Page, count = 1) {
  await page.evaluate(count => { window.__kidLogin.captureSubmit(); window.__kidLogin.fireCaptured(count); }, count);
}
async function settled(page: Page) {
  await page.evaluate(() => window.__kidLogin.settle());
  expect(await page.evaluate(() => window.__kidLogin.errors)).toEqual([]);
}
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('verified child tokens are adopted through the real SDK before one home navigation', async ({ page }) => {
  const state = await fixture(page); await fill(page); await submit(page); await settled(page);
  expect(await page.evaluate(() => window.__kidLogin.calls)).toEqual([{ username: 'emma', pin: '1234' }]);
  expect(state.requests).toEqual(['GET /auth/v1/user']);
  expect(await page.evaluate(() => window.__kidLogin.currentUser())).toBe(userA);
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual(['/home']);
  expect(await page.evaluate(() => window.__kidLogin.refreshes)).toBe(1);
});

test('same-tick duplicate submits make one server action call', async ({ page }) => {
  await fixture(page, 'hold'); await fill(page); await submit(page, 3);
  await expect.poll(() => page.evaluate(() => window.__kidLogin.calls.length)).toBe(1);
  await page.evaluate(() => window.__kidLogin.release()); await settled(page);
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual(['/home']);
});

for (const [username, pin] of [['ab', '1234'], ['emma', '123']]) {
  test(`invalid child credentials never dispatch (${username}/${pin.length} digits)`, async ({ page }) => {
    await fixture(page); await fill(page, username, pin); await submit(page); await settled(page);
    expect(await page.evaluate(() => window.__kidLogin.calls)).toEqual([]);
    expect(await page.evaluate(() => window.__kidLogin.toasts.length)).toBe(1);
  });
}

test('a rejected PIN is translated and permits a fresh retry', async ({ page }) => {
  await fixture(page, 'reject'); await fill(page); await submit(page); await settled(page);
  const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
  expect(await page.evaluate(() => window.__kidLogin.toasts)).toEqual([messages['actions.thatUsernameOrPinIsn']]);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await page.evaluate(() => { window.__kidLogin.mode = 'success'; });
  await submit(page); await settled(page);
  expect(await page.evaluate(() => window.__kidLogin.calls.length)).toBe(2);
  expect(await page.evaluate(() => window.__kidLogin.currentUser())).toBe(userA);
});

test('an unexpected action failure uses the translated fallback without exposing diagnostics', async ({ page }) => {
  await fixture(page, 'throw', 'fr-FR'); await fill(page); await submit(page); await settled(page);
  const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/fr-FR.json', 'utf8'));
  expect(await page.evaluate(() => window.__kidLogin.toasts)).toEqual([messages['actions.kidSignInIsTemporarily']]);
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual([]);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
});

test('a delayed child response preserves newer B and performs no stale verification or navigation', async ({ page }) => {
  const state = await fixture(page, 'hold'); await fill(page); await submit(page);
  await expect.poll(() => page.evaluate(() => window.__kidLogin.calls.length)).toBe(1);
  await page.evaluate(() => window.__kidLogin.signInB());
  await page.evaluate(() => window.__kidLogin.release()); await settled(page);
  expect(state.requests).toEqual(['POST /auth/v1/token']);
  expect(await page.evaluate(() => window.__kidLogin.currentUser())).toBe(userB);
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual([]);
});

test('explicit logout from empty storage invalidates the pending child response', async ({ page }) => {
  const state = await fixture(page, 'hold'); await fill(page); await submit(page);
  await expect.poll(() => page.evaluate(() => window.__kidLogin.calls.length)).toBe(1);
  await page.evaluate(() => window.__kidLogin.logout());
  await page.evaluate(() => window.__kidLogin.release()); await settled(page);
  expect(state.requests).toEqual([]);
  expect(await page.evaluate(() => window.__kidLogin.currentUser())).toBeNull();
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual([]);
});

test('unmount retires a pending child action and suppresses late toasts/navigation', async ({ page }) => {
  const state = await fixture(page, 'hold'); await fill(page); await submit(page);
  await expect.poll(() => page.evaluate(() => window.__kidLogin.calls.length)).toBe(1);
  await page.evaluate(() => { window.__kidLogin.retire(); window.__kidLogin.release(); }); await settled(page);
  expect(state.requests).toEqual([]);
  expect(await page.evaluate(() => window.__kidLogin.toasts)).toEqual([]);
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual([]);
});

test('an old submit callback cannot start an action after the form is replaced', async ({ page }) => {
  await fixture(page); await fill(page);
  await page.evaluate(() => { window.__kidLogin.captureSubmit(); window.__kidLogin.retire(); window.__kidLogin.mount(); window.__kidLogin.fireCaptured(); });
  await settled(page);
  expect(await page.evaluate(() => window.__kidLogin.calls)).toEqual([]);
});

test('a retained callback reads the current form credentials after editing', async ({ page }) => {
  await fixture(page); await fill(page); await page.evaluate(() => window.__kidLogin.captureSubmit());
  await fill(page, 'jane', '5678');
  await page.evaluate(() => window.__kidLogin.fireCaptured()); await settled(page);
  expect(await page.evaluate(() => window.__kidLogin.calls)).toEqual([{ username: 'jane', pin: '5678' }]);
});

test('the grown-up login link retires pending child adoption immediately', async ({ page }) => {
  const state = await fixture(page, 'hold'); await fill(page); await submit(page);
  await expect.poll(() => page.evaluate(() => window.__kidLogin.calls.length)).toBe(1);
  await page.locator('a[href="/login"]').click();
  await page.evaluate(() => window.__kidLogin.release()); await settled(page);
  expect(state.requests).toEqual([]);
  expect(await page.evaluate(() => window.__kidLogin.links)).toEqual(['/login']);
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual([]);
  expect(await page.evaluate(() => window.__kidLogin.toasts)).toEqual([]);
});

test('opening the grown-up link in another tab leaves the current form attempt active', async ({ page }) => {
  await fixture(page, 'hold'); await fill(page); await submit(page);
  await expect.poll(() => page.evaluate(() => window.__kidLogin.calls.length)).toBe(1);
  await page.locator('a[href="/login"]').click({ modifiers: ['Control'] });
  await page.evaluate(() => window.__kidLogin.release()); await settled(page);
  expect(await page.evaluate(() => window.__kidLogin.currentUser())).toBe(userA);
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual(['/home']);
});

test('provider rejection of the returned token preserves the previous B session', async ({ page }) => {
  const state = await fixture(page); await page.evaluate(() => window.__kidLogin.signInB());
  state.rejectVerification = true;
  await fill(page); await submit(page); await settled(page);
  expect(await page.evaluate(() => window.__kidLogin.currentUser())).toBe(userB);
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual([]);
  expect(await page.evaluate(() => window.__kidLogin.toasts.length)).toBe(1);
});

test('malformed tokens from a broken action response are never adopted', async ({ page }) => {
  await fixture(page, 'malformed'); await fill(page); await submit(page); await settled(page);
  expect(await page.evaluate(() => window.__kidLogin.currentUser())).toBeNull();
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual([]);
  expect(await page.evaluate(() => window.__kidLogin.toasts.length)).toBe(1);
});

test('blocked cookie writes produce a retryable failure rather than navigation', async ({ page }) => {
  await fixture(page); await page.evaluate(() => window.__kidLogin.failWrites());
  await fill(page); await submit(page); await settled(page);
  expect(await page.evaluate(() => window.__kidLogin.currentUser())).toBeNull();
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual([]);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
});

test('a timed-out child action permits retry and its late response cannot act again', async ({ page }) => {
  const state = await fixture(page, 'hold'); await page.clock.install(); await fill(page); await submit(page);
  await expect.poll(() => page.evaluate(() => window.__kidLogin.calls.length)).toBe(1);
  await page.clock.runFor(20_100); await settled(page);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await page.evaluate(() => { window.__kidLogin.mode = 'success'; });
  await submit(page); await settled(page);
  await page.evaluate(() => window.__kidLogin.release());
  await page.clock.runFor(100);
  expect(state.requests).toEqual(['GET /auth/v1/user']);
  expect(await page.evaluate(() => window.__kidLogin.navigations)).toEqual(['/home']);
  expect(await page.evaluate(() => window.__kidLogin.currentUser())).toBe(userA);
});
