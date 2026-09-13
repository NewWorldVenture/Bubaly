import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Actual SignupForm, validation, selection/referral helpers, Locale/Toast providers,
// production browser factory, installed SSR cookie adapter and auth SDK. Provider
// HTTP and server-action/navigation boundaries are controlled; no live accounts.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const isolated = new Set(['react', 'lucide-react', 'next/link', 'next/navigation', '@/components/auth/oauth-buttons',
  '@/components/auth/phone-auth', '@/app/(auth)/actions', '@/app/(auth)/signup/actions', '@/lib/utils/cn', '@capacitor/core', '@capacitor/haptics']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function sourceFile(filename: string) {
  return [filename, `${filename}.ts`, `${filename}.tsx`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? filename;
}
function collect(filename: string): string {
  const id = path.resolve(sourceFile(filename));
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = id.endsWith('.json') ? `module.exports = { default: ${JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw))
    .filter(([key]) => /^(signup\.|signupForm\.|legalConsent\.|toast\.)/.test(key))))} };`
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
const entries = Object.fromEntries(['components/auth/signup-form.tsx', 'components/ui/toast.tsx', 'components/i18n/locale-provider.tsx',
  'lib/i18n/locales.ts', 'lib/supabase/client.ts'].map(file => [file, collect(file)]));
const origin = 'https://signup-boundaries-fixture.invalid';
const provider = 'https://signup-provider.invalid';
const existingUser = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const newUser = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type Mode = 'confirm' | 'session' | 'reject' | 'lost' | 'network' | 'timeout' | 'rate-limit' | 'server-error' | 'malformed' | 'invalid-user' | 'invalid-session-user' | 'invalid-session-token' | 'unreadable-error';
type SignupRequest = { body: Record<string, unknown>; url: string };
type Fixture = { mode: Mode; hold: boolean; signups: SignupRequest[]; accepted: number; calls: string[]; exchanges: Record<string, unknown>[];
  release: () => Promise<void>; releaseOne: (index?: number) => Promise<void> };
type Probe = {
  mount: (query?: string) => void; retire: () => void; captureSubmit: () => void; fireCaptured: (times?: number) => void;
  settleSubmits: () => Promise<void>; pending: number; errors: string[]; navigations: string[]; refreshes: number;
  stitches: number; referrals: string[]; rejectStitch: boolean; rejectReferral: boolean;
  pkce: () => Promise<string | null>; user: () => Promise<string | null>; signIn: () => Promise<void>;
  signOut: () => Promise<void>; recover: () => Promise<void>; oauth: () => Promise<string>;
  exchange: () => Promise<void>; refreshSession: () => Promise<void>; seedSession: (padding: number, expired?: boolean) => Promise<void>;
  storedUser: () => Promise<string | null>; events: Array<{ event: string; user: string | null }>;
};
declare global { interface Window { __signupBoundaries: Probe } }
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

function user(id: string) {
  return { id, aud: 'authenticated', role: 'authenticated', email: `${id === existingUser ? 'existing' : 'new'}@example.invalid`,
    app_metadata: {}, user_metadata: {}, identities: [{ id, user_id: id, provider: 'email' }], created_at: '2026-09-12T00:00:00Z' };
}
function session(id: string) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const jwt = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: id, session_id: '11111111-1111-4111-8111-111111111111', exp: expires, aud: 'authenticated' })).toString('base64url'), 'synthetic-signature'].join('.');
  return { access_token: jwt, refresh_token: 'synthetic-refresh-only', expires_at: expires, expires_in: 3600, token_type: 'bearer', user: user(id) };
}
async function fixture(page: Page, options: { mode?: Mode; hold?: boolean; query?: string; locale?: string } = {}): Promise<Fixture> {
  const held: Array<() => Promise<void>> = [];
  const state: Fixture = { mode: options.mode ?? 'confirm', hold: options.hold ?? false, signups: [], accepted: 0, calls: [], exchanges: [],
    release: async () => { state.hold = false; await Promise.all(held.splice(0).map(finish => finish())); },
    releaseOne: async (index = 0) => { await held.splice(index, 1)[0](); } };
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }); return; }
    if (url.origin !== provider) throw new Error(`Unexpected fixture destination: ${url.origin}`);
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    state.calls.push(`${request.method()} ${url.pathname}${url.search}`);
    if (url.pathname === '/auth/v1/logout') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/recover') { await route.fulfill({ contentType: 'application/json', headers, body: '{}' }); return; }
    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'pkce') {
        const body = request.postDataJSON() as Record<string, unknown>; state.exchanges.push(body);
        const match = state.accepted > 0 && typeof body.code_verifier === 'string' && state.signups.some(signup => signup.body.code_challenge === challenge(body.code_verifier as string));
        await route.fulfill({ status: match ? 200 : 400, contentType: 'application/json', headers,
          body: JSON.stringify(match ? session(newUser) : { code: 'bad_code_verifier', message: 'Fixture verifier mismatch' }) }); return;
      }
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(session(existingUser)) }); return;
    }
    if (url.pathname !== '/auth/v1/signup' || request.method() !== 'POST') throw new Error(`Unexpected fixture request: ${request.method()} ${url.pathname}`);
    state.signups.push({ body: request.postDataJSON() as Record<string, unknown>, url: request.url() });
    const mode = state.mode;
    if (mode !== 'reject' && mode !== 'malformed') state.accepted++;
    const finish = async () => {
      if (mode === 'network') { await route.abort('failed'); return; }
      if (mode === 'unreadable-error') { await route.fulfill({ status: 400, headers, contentType: 'text/html', body: '<html>Fixture unreadable gateway response</html>' }); return; }
      const body = mode === 'reject' ? { code: 'email_address_invalid', msg: 'Fixture email rejected' }
        : mode === 'lost' ? { message: 'Fixture response lost after signup was accepted' }
        : mode === 'invalid-user' ? { ...user(newUser), id: 'invalid-user-id' }
        : mode === 'invalid-session-user' ? { ...session(newUser), user: { ...user(newUser), id: 'invalid-user-id' } }
        : mode === 'invalid-session-token' ? { ...session(newUser), access_token: '   ' }
        : mode === 'malformed' ? {} : mode === 'session' ? session(newUser) : user(newUser);
      const status = mode === 'reject' ? 400 : mode === 'lost' ? 502 : mode === 'timeout' ? 408 : mode === 'rate-limit' ? 429 : mode === 'server-error' ? 500 : 200;
      await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    };
    if (state.hold) held.push(finish); else await finish();
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  const locale = options.locale ?? 'en-US';
  const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')))
    .filter(([key]) => /^(signup\.|signupForm\.|legalConsent\.|toast\.)/.test(key)));
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, loaded = {}, entries = ${JSON.stringify(entries)}, messages = ${JSON.stringify(messages)};
    const p = window.__signupBoundaries = { errors: [], navigations: [], refreshes: 0, stitches: 0, referrals: [], pending: 0, rejectStitch: false, rejectReferral: false, events: [] };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    let query = ${JSON.stringify(options.query ?? '')}, show = true, root, captured, jobs = [];
    const router = { push: href => p.navigations.push(href), refresh: () => { p.refreshes++; } };
    const mocks = { react: React, '@supabase/supabase-js': window.supabase,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
      'next/navigation': { useRouter: () => router, useSearchParams: () => new URLSearchParams(query) },
      '@/components/auth/oauth-buttons': { authButtonClass: '', OAuthButtons: ({ next }) => React.createElement('span', { 'data-testid': 'oauth-next', 'data-next': next }) },
      '@/components/auth/phone-auth': { PhoneAuth: ({ next, onBack }) => React.createElement('button', { onClick: onBack, 'data-testid': 'phone-next', 'data-next': next }, 'Back from phone') },
      '@/app/(auth)/actions': { stitchIdentityAction: async () => { p.stitches++; if (p.rejectStitch) throw new Error('Fixture stitch failed'); } },
      '@/app/(auth)/signup/actions': { rememberReferralCodeAction: async code => { p.referrals.push(code); if (p.rejectReferral) throw new Error('Fixture referral failed'); } },
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
      '@capacitor/core': { Capacitor: { isNativePlatform: () => false } }, '@capacitor/haptics': {},
    };
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-fixture' } };
    function load(id) {
      if (id in mocks) return mocks[id]; if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module: ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process);
      return module.exports;
    }
    const SignupForm = load(entries['components/auth/signup-form.tsx']).SignupForm;
    const ToastProvider = load(entries['components/ui/toast.tsx']).ToastProvider;
    const LocaleProvider = load(entries['components/i18n/locale-provider.tsx']).LocaleProvider;
    const locale = load(entries['lib/i18n/locales.ts']).localeOrDefault(${JSON.stringify(locale)});
    const db = load(entries['lib/supabase/client.ts']).createClient();
    db.auth.onAuthStateChange((event, session) => p.events.push({ event, user: session?.user.id ?? null }));
    function render() {
      root ??= ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(LocaleProvider, { locale, source: 'default', messages },
        React.createElement(ToastProvider, null, show ? React.createElement(SignupForm) : React.createElement('p', null, 'Other route')))));
    }
    p.mount = value => { if (value !== undefined) query = value; show = true; render(); };
    p.retire = () => { show = false; render(); };
    p.captureSubmit = () => {
      const form = document.querySelector('form');
      const submit = form[Object.keys(form).find(key => key.startsWith('__reactProps$'))].onSubmit;
      captured = () => submit({ preventDefault() {}, currentTarget: form });
    };
    p.fireCaptured = (times = 1) => { for (let i = 0; i < times; i++) { p.pending++; jobs.push(Promise.resolve(captured()).catch(error => p.errors.push(String(error))).finally(() => { p.pending--; })); } };
    p.settleSubmits = async () => { await Promise.all(jobs); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
    p.pkce = async () => { const value = await db.auth.storage.getItem(db.auth.storageKey + '-code-verifier'); return value === null ? null : JSON.parse(value); };
    p.user = async () => (await db.auth.getSession()).data.session?.user.id ?? null;
    p.signIn = async () => { const result = await db.auth.signInWithPassword({ email: 'existing@example.invalid', password: 'synthetic-password' }); if (result.error) throw result.error; };
    p.signOut = async () => { const result = await db.auth.signOut({ scope: 'local' }); if (result.error) throw result.error; };
    p.recover = async () => { const result = await db.auth.resetPasswordForEmail('recovery@example.invalid'); if (result.error) throw result.error; };
    p.oauth = async () => { const result = await db.auth.signInWithOAuth({ provider: 'google', options: { skipBrowserRedirect: true } }); if (result.error) throw result.error; return result.data.url; };
    p.exchange = async () => { const result = await db.auth.exchangeCodeForSession('synthetic-accepted-signup'); if (result.error) throw result.error; };
    p.refreshSession = async () => { const result = await db.auth.refreshSession(); if (result.error) throw result.error; };
    p.storedUser = async () => { const value = await db.auth.storage.getItem(db.auth.storageKey); return value ? JSON.parse(value).user.id : null; };
    p.seedSession = async (padding, expired = false) => {
      await db.auth.getSession(); await db.auth.stopAutoRefresh();
      const value = ${JSON.stringify(session(existingUser))}; value.user.user_metadata.padding = 'x'.repeat(padding);
      if (expired) value.expires_at = Math.floor(Date.now() / 1000) - 3600;
      await db.auth.storage.setItem(db.auth.storageKey, JSON.stringify(value));
    };
    p.mount();
  })();` });
  return state;
}
async function emailForm(page: Page) {
  await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await page.locator('input[name="fullName"]').fill('  Jordan Rivera  ');
  await page.locator('input[name="email"]').fill('NEW@EXAMPLE.INVALID');
  await page.locator('input[name="password"]').fill('synthetic-password');
}
async function retained(page: Page, times = 1) {
  await page.evaluate(times => { window.__signupBoundaries.captureSubmit(); window.__signupBoundaries.fireCaptured(times); }, times);
}
const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');

test('control: confirmation-required signup sends normalized referral/selection and stores the real PKCE challenge', async ({ page }) => {
  const state = await fixture(page, { hold: true, query: 'ref=smith-7k4q&reviewPlan=plus_annual' }); await emailForm(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect.poll(() => state.signups.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeDisabled();
  for (const name of ['fullName', 'email', 'password']) await expect(page.locator(`input[name="${name}"]`)).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  const verifier = await page.evaluate(() => window.__signupBoundaries.pkce());
  expect(verifier).toBeTruthy();
  expect(state.signups[0].body).toMatchObject({ email: 'new@example.invalid', data: { full_name: 'Jordan Rivera', referral_code: 'SMITH-7K4Q' }, code_challenge_method: 's256', code_challenge: challenge(verifier!) });
  expect(new URL(state.signups[0].url).searchParams.get('redirect_to')).toBe(`${origin}/auth/callback?next=%2Fonboarding%3FreviewPlan%3Dplus_annual`);
  expect(await page.evaluate(() => window.__signupBoundaries.referrals)).toEqual(['SMITH-7K4Q']);
  await state.release(); await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login?reviewPlan=plus_annual');
  expect(await page.evaluate(async () => ({ user: await window.__signupBoundaries.user(), nav: window.__signupBoundaries.navigations, stitches: window.__signupBoundaries.stitches }))).toEqual({ user: null, nav: [], stitches: 0 });
});

test('control: auto-confirmed signup persists its session and honors a safe invite before plan selection', async ({ page }) => {
  const state = await fixture(page, { mode: 'session', query: 'redirect=%2Finvite%2Fjoin%3Fcode%3Dsynthetic&reviewPlan=plus_annual' }); await emailForm(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__signupBoundaries.navigations)).toEqual(['/invite/join?code=synthetic']);
  expect(await page.evaluate(() => window.__signupBoundaries.user())).toBe(newUser);
  expect(await page.evaluate(() => ({ stitches: window.__signupBoundaries.stitches, refreshes: window.__signupBoundaries.refreshes, errors: window.__signupBoundaries.errors }))).toEqual({ stitches: 1, refreshes: 1, errors: [] });
  expect(state.signups).toHaveLength(1); await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
});

test('control: validation and definitive provider rejection preserve input for an intentional retry', async ({ page }) => {
  const state = await fixture(page, { mode: 'reject' }); await emailForm(page);
  await page.locator('input[name="password"]').fill('short'); await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Use at least 8 characters'); expect(state.signups).toHaveLength(0);
  await page.locator('input[name="password"]').fill('synthetic-password'); await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Fixture email rejected');
  expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBeNull();
  await expect(page.locator('input[name="email"]')).toHaveValue('NEW@EXAMPLE.INVALID');
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeEnabled();
  state.mode = 'confirm'; await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible(); expect(state.signups).toHaveLength(2); expect(state.accepted).toBe(1);
});

test('control: confirmation-required signup does not silently delete an existing session', async ({ page }) => {
  await fixture(page); await page.evaluate(() => window.__signupBoundaries.signIn()); await emailForm(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(await page.evaluate(() => window.__signupBoundaries.user())).toBe(existingUser);
  expect(await page.evaluate(() => window.__signupBoundaries.navigations)).toEqual([]);
});

test('desired: two synchronous retained submits dispatch one signup and preserve its PKCE verifier', async ({ page }) => {
  const state = await fixture(page, { hold: true }); await emailForm(page); await retained(page, 2);
  await expect.poll(() => state.signups.length).toBeGreaterThan(0);
  await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect.soft(state.signups).toHaveLength(1);
  expect(challenge((await page.evaluate(() => window.__signupBoundaries.pkce()))!)).toBe(state.signups[0].body.code_challenge);
});

test('desired: a retained submit after confirmation cannot create another signup', async ({ page }) => {
  const state = await fixture(page); await emailForm(page); await retained(page);
  await page.evaluate(() => window.__signupBoundaries.settleSubmits()); await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.evaluate(() => window.__signupBoundaries.fireCaptured()); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(state.signups).toHaveLength(1);
});

test('desired: a callback retained before unmount cannot dispatch after another form mounts', async ({ page }) => {
  const state = await fixture(page); await emailForm(page); await page.evaluate(() => { window.__signupBoundaries.captureSubmit(); window.__signupBoundaries.retire(); window.__signupBoundaries.mount(); window.__signupBoundaries.fireCaptured(); });
  await page.evaluate(() => window.__signupBoundaries.settleSubmits()); expect(state.signups).toHaveLength(0);
});

test('desired: accepted signup released after unmount cannot stitch or navigate the retired form', async ({ page }) => {
  const state = await fixture(page, { mode: 'session', hold: true }); await emailForm(page); await retained(page);
  await expect.poll(() => state.signups.length).toBe(1); await page.evaluate(() => window.__signupBoundaries.retire());
  await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(state.accepted).toBe(1);
  expect(await page.evaluate(() => ({ nav: window.__signupBoundaries.navigations, stitches: window.__signupBoundaries.stitches, refreshes: window.__signupBoundaries.refreshes }))).toEqual({ nav: [], stitches: 0, refreshes: 0 });
  expect(await page.evaluate(() => window.__signupBoundaries.storedUser())).toBeNull();
  expect(await page.evaluate(() => window.__signupBoundaries.events.filter(item => item.event === 'SIGNED_IN'))).toEqual([]);
});

test('desired: provider rejection released after unmount does not toast onto the next route', async ({ page }) => {
  const state = await fixture(page, { mode: 'reject', hold: true }); await emailForm(page); await retained(page);
  await expect.poll(() => state.signups.length).toBe(1); await page.evaluate(() => window.__signupBoundaries.retire());
  await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits()); expect(await page.getByRole('alert').count()).toBe(0);
});

test('regression: accepted-but-lost signup offers honest review and blocks blind repeat', async ({ page }) => {
  const state = await fixture(page, { mode: 'lost', hold: true }); await emailForm(page); await retained(page);
  await expect.poll(() => state.signups.length).toBe(1); const verifier = await page.evaluate(() => window.__signupBoundaries.pkce());
  expect(challenge(verifier!)).toBe(state.signups[0].body.code_challenge);
  await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(state.accepted).toBe(1); await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Check your signup request' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login');
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.__signupBoundaries.fireCaptured()); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(state.signups).toHaveLength(1);
});

test('an accepted signup followed by 502 keeps its verifier for a later SDK code exchange', async ({ page }) => {
  const state = await fixture(page, { mode: 'lost', hold: true }); await emailForm(page); await retained(page);
  await expect.poll(() => state.signups.length).toBe(1);
  const verifier = await page.evaluate(() => window.__signupBoundaries.pkce());
  expect(challenge(verifier!)).toBe(state.signups[0].body.code_challenge);
  await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(state.accepted).toBe(1);
  expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBe(verifier);
  await page.evaluate(() => window.__signupBoundaries.exchange());
  expect(state.exchanges).toEqual([{ auth_code: 'synthetic-accepted-signup', code_verifier: verifier }]);
  expect(await page.evaluate(() => window.__signupBoundaries.user())).toBe(newUser);
  expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBeNull();
});

test('desired: empty successful provider receipt does not claim a confirmation email was sent', async ({ page }) => {
  await fixture(page, { mode: 'malformed' }); await emailForm(page); await retained(page); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(await page.getByRole('heading', { name: 'Check your email' }).count()).toBe(0);
});

test('desired: best-effort identity stitching rejection is contained after confirmed signup', async ({ page }) => {
  await fixture(page, { mode: 'session' }); await page.evaluate(() => { window.__signupBoundaries.rejectStitch = true; }); await emailForm(page); await retained(page);
  await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(await page.evaluate(() => window.__signupBoundaries.navigations)).toEqual(['/onboarding']);
  expect(await page.evaluate(() => window.__signupBoundaries.errors)).toEqual([]);
});

test('control: the confirmation-required result uses the real French locale catalogue', async ({ page }) => {
  await fixture(page, { locale: 'fr-FR' });
  const catalogue = JSON.parse(fs.readFileSync('lib/i18n/messages/fr-FR.json', 'utf8')) as Record<string, string>;
  await page.getByRole('button', { name: catalogue['signup.continueWithEmail'], exact: true }).click();
  await page.locator('input[name="fullName"]').fill('Camille Martin');
  await page.locator('input[name="email"]').fill('camille@example.invalid');
  await page.locator('input[name="password"]').fill('synthetic-password');
  await page.getByRole('button', { name: catalogue['signup.createAccount'], exact: true }).click();
  await expect(page.getByRole('heading', { name: catalogue['signup.checkEmailTitle'], exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: catalogue['signup.backToSignIn'], exact: true })).toHaveAttribute('href', '/login');
  expect(await page.evaluate(() => window.__signupBoundaries.errors)).toEqual([]);
});

test('desired: a best-effort referral action rejection does not become an unhandled browser rejection', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { window.__signupBoundaries.rejectReferral = true; window.__signupBoundaries.mount('ref=smith-7k4q'); });
  await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(await page.evaluate(() => window.__signupBoundaries.referrals)).toEqual(['SMITH-7K4Q']);
  expect(await page.evaluate(() => window.__signupBoundaries.errors)).toEqual([]);
});

test('a changed destination while pending settles into review without stale navigation or another signup', async ({ page }) => {
  const state = await fixture(page, { mode: 'session', hold: true, query: 'reviewPlan=plus_annual' }); await emailForm(page); await retained(page);
  await expect.poll(() => state.signups.length).toBe(1);
  await page.evaluate(() => window.__signupBoundaries.mount('redirect=%2Finvite%2Fcurrent'));
  await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  await expect(page.getByRole('heading', { name: 'Check your signup request' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login?redirect=%2Finvite%2Fcurrent');
  expect(await page.evaluate(() => ({ nav: window.__signupBoundaries.navigations, stitches: window.__signupBoundaries.stitches }))).toEqual({ nav: [], stitches: 0 });
  await page.evaluate(() => window.__signupBoundaries.fireCaptured()); await page.evaluate(() => window.__signupBoundaries.settleSubmits()); expect(state.signups).toHaveLength(1);
});

test('an idle destination change retires the old callback and keeps the current form usable', async ({ page }) => {
  const state = await fixture(page, { mode: 'session' }); await emailForm(page);
  await page.evaluate(() => { window.__signupBoundaries.captureSubmit(); window.__signupBoundaries.mount('reviewPlan=basic_annual'); window.__signupBoundaries.fireCaptured(); });
  await page.evaluate(() => window.__signupBoundaries.settleSubmits()); expect(state.signups).toHaveLength(0);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__signupBoundaries.navigations)).toEqual(['/onboarding?reviewPlan=basic_annual']);
  expect(state.signups).toHaveLength(1);
});

for (const mode of ['invalid-user', 'invalid-session-user', 'invalid-session-token', 'unreadable-error'] as const) {
  test(`unverified ${mode} response goes to review and cannot resend`, async ({ page }) => {
    const state = await fixture(page, { mode }); await emailForm(page); await retained(page); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
    await expect(page.getByRole('heading', { name: 'Check your signup request' })).toBeVisible();
    expect(await page.evaluate(() => ({ nav: window.__signupBoundaries.navigations, stitches: window.__signupBoundaries.stitches, errors: window.__signupBoundaries.errors }))).toEqual({ nav: [], stitches: 0, errors: [] });
    expect(await page.evaluate(() => window.__signupBoundaries.storedUser())).toBeNull();
    await page.evaluate(() => window.__signupBoundaries.fireCaptured()); await page.evaluate(() => window.__signupBoundaries.settleSubmits()); expect(state.signups).toHaveLength(1);
  });
}

test('French uncertainty copy preserves the selected-plan sign-in recovery link', async ({ page }) => {
  const state = await fixture(page, { mode: 'lost', locale: 'fr-FR', query: 'reviewPlan=plus_annual' });
  const catalogue = JSON.parse(fs.readFileSync('lib/i18n/messages/fr-FR.json', 'utf8')) as Record<string, string>;
  await page.getByRole('button', { name: catalogue['signup.continueWithEmail'], exact: true }).click();
  await page.locator('input[name="fullName"]').fill('Camille Martin'); await page.locator('input[name="email"]').fill('camille@example.invalid'); await page.locator('input[name="password"]').fill('synthetic-password');
  await retained(page); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(catalogue['signupForm.unconfirmedTitle']).toBeTruthy();
  await expect(page.getByRole('heading', { name: catalogue['signupForm.unconfirmedTitle'], exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(catalogue['signupForm.unconfirmedBody']);
  await expect(page.getByRole('link', { name: catalogue['signup.signIn'], exact: true })).toHaveAttribute('href', '/login?reviewPlan=plus_annual');
  expect(state.signups).toHaveLength(1);
});

for (const mode of ['network', 'timeout', 'rate-limit', 'server-error', 'unreadable-error'] as const) {
  test(`uncertain ${mode} preserves the exact dispatched verifier and permits no automatic retry`, async ({ page }) => {
    const state = await fixture(page, { mode, hold: true }); await emailForm(page); await retained(page);
    await expect.poll(() => state.signups.length).toBe(1);
    const verifier = await page.evaluate(() => window.__signupBoundaries.pkce());
    expect(challenge(verifier!)).toBe(state.signups[0].body.code_challenge);
    await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
    expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBe(verifier);
    await expect(page.getByRole('heading', { name: 'Check your signup request' })).toBeVisible();
    expect(state.signups).toHaveLength(1);
  });
}

for (const mode of ['lost', 'reject', 'session'] as const) {
  test(`older ${mode} signup cannot delete or overwrite a newer form's verifier`, async ({ page }) => {
    const state = await fixture(page, { mode, hold: true }); await emailForm(page); await retained(page);
    await expect.poll(() => state.signups.length).toBe(1);
    await page.evaluate(() => { window.__signupBoundaries.retire(); window.__signupBoundaries.mount(); });
    state.mode = 'confirm'; await emailForm(page); await retained(page);
    await expect.poll(() => state.signups.length).toBe(2);
    const newer = await page.evaluate(() => window.__signupBoundaries.pkce());
    expect(challenge(newer!)).toBe(state.signups[1].body.code_challenge);
    expect(state.signups[0].body.code_challenge).not.toBe(state.signups[1].body.code_challenge);
    await state.releaseOne(1); await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
    expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBe(newer);
    expect(await page.evaluate(() => window.__signupBoundaries.storedUser())).toBeNull();
    expect(await page.evaluate(() => window.__signupBoundaries.navigations)).toEqual([]);
  });
}

for (const newer of ['recover', 'oauth'] as const) {
  for (const mode of ['lost', 'reject', 'session'] as const) {
    test(`older ${mode} signup respects a newer SDK ${newer} verifier`, async ({ page }) => {
      const state = await fixture(page, { mode, hold: true }); await emailForm(page); await retained(page);
      await expect.poll(() => state.signups.length).toBe(1);
      const oldVerifier = await page.evaluate(() => window.__signupBoundaries.pkce());
      const oauthUrl = await page.evaluate(async kind => {
        if (kind === 'oauth') return window.__signupBoundaries.oauth();
        await window.__signupBoundaries.recover(); return null;
      }, newer);
      const verifier = await page.evaluate(() => window.__signupBoundaries.pkce());
      expect(verifier).toBeTruthy(); expect(verifier).not.toBe(oldVerifier);
      if (oauthUrl) expect(new URL(oauthUrl).searchParams.get('code_challenge')).toBe(challenge(verifier!));
      else expect(verifier).toMatch(/\/recovery$/);
      await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
      expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBe(verifier);
      expect(await page.evaluate(() => window.__signupBoundaries.storedUser())).toBeNull();
      expect(await page.evaluate(() => window.__signupBoundaries.navigations)).toEqual([]);
    });
  }
}

for (const boundary of ['signOut', 'exchange'] as const) {
  for (const mode of ['lost', 'session'] as const) {
    test(`${boundary} consumption during a pending ${mode} signup is never undone`, async ({ page }) => {
      const state = await fixture(page, { mode, hold: true });
      if (boundary === 'signOut') await page.evaluate(() => window.__signupBoundaries.signIn());
      await emailForm(page); await retained(page); await expect.poll(() => state.signups.length).toBe(1);
      await page.evaluate(async kind => { await window.__signupBoundaries[kind](); }, boundary);
      expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBeNull();
      await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
      expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBeNull();
      expect(await page.evaluate(() => window.__signupBoundaries.storedUser())).toBe(boundary === 'exchange' ? newUser : null);
      expect(await page.evaluate(() => window.__signupBoundaries.navigations)).toEqual([]);
    });
  }
}

test('isolated signup never initializes or refreshes an expired ambient session', async ({ page }) => {
  const state = await fixture(page); await page.evaluate(() => window.__signupBoundaries.seedSession(10000, true));
  const before = (await page.context().cookies()).filter(cookie => /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name));
  await emailForm(page); await retained(page); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(state.calls.filter(call => call.includes('/auth/v1/token'))).toEqual([]);
  const after = (await page.context().cookies()).filter(cookie => /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name));
  expect(after.map(({ name, value }) => ({ name, value }))).toEqual(before.map(({ name, value }) => ({ name, value })));
});

test('confirmed owned signup replaces every stale ambient session chunk and emits SIGNED_IN to the singleton', async ({ page }) => {
  await fixture(page, { mode: 'session' }); await page.evaluate(() => window.__signupBoundaries.seedSession(10000));
  expect((await page.context().cookies()).filter(cookie => /^sb-.+-auth-token\.\d+$/.test(cookie.name)).length).toBeGreaterThan(3);
  await emailForm(page); await retained(page); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(await page.evaluate(() => window.__signupBoundaries.storedUser())).toBe(newUser);
  expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBeNull();
  expect((await page.context().cookies()).filter(cookie => /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name)).map(cookie => cookie.name))
    .toEqual(['sb-signup-provider-auth-token']);
  await expect.poll(() => page.evaluate(id => window.__signupBoundaries.events.filter(item => item.event === 'SIGNED_IN' && item.user === id), newUser))
    .toEqual([{ event: 'SIGNED_IN', user: newUser }]);
});

test('known separate SDK limitation: a later singleton refresh still consumes a pending signup verifier', async ({ page }) => {
  await fixture(page, { mode: 'lost' }); await page.evaluate(() => window.__signupBoundaries.signIn());
  await emailForm(page); await retained(page); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBeTruthy();
  await page.evaluate(() => window.__signupBoundaries.refreshSession());
  expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBeNull();
  expect(await page.evaluate(() => window.__signupBoundaries.storedUser())).toBe(existingUser);
});

test('blocked verifier cookie storage prevents a signup from being dispatched', async ({ page }) => {
  const state = await fixture(page);
  await page.evaluate(() => {
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', {
      get: () => cookie.get!.call(document),
      set: value => { if (!String(value).includes('-code-verifier=')) cookie.set!.call(document, value); },
    });
  });
  await emailForm(page); await retained(page); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(state.signups).toHaveLength(0);
  expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBeNull();
  await expect(page.getByRole('heading', { name: 'Check your signup request' })).toBeVisible();
});

test('uncertain completion after unmount leaves the dispatched verifier available without showing stale UI', async ({ page }) => {
  const state = await fixture(page, { mode: 'lost', hold: true }); await emailForm(page); await retained(page);
  await expect.poll(() => state.signups.length).toBe(1);
  const verifier = await page.evaluate(() => window.__signupBoundaries.pkce());
  await page.evaluate(() => window.__signupBoundaries.retire());
  await state.release(); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBe(verifier);
  expect(await page.evaluate(() => window.__signupBoundaries.navigations)).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Check your signup request' })).toHaveCount(0);
});

test('blocked session cookie adoption cannot publish SIGNED_IN or claim confirmed signup', async ({ page }) => {
  const state = await fixture(page, { mode: 'session' });
  await page.evaluate(() => {
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', {
      get: () => cookie.get!.call(document),
      set: value => { if (!/^sb-.+-auth-token(?:\.\d+)?=/.test(String(value))) cookie.set!.call(document, value); },
    });
  });
  await emailForm(page); await retained(page); await page.evaluate(() => window.__signupBoundaries.settleSubmits());
  expect(state.accepted).toBe(1);
  expect(await page.evaluate(() => window.__signupBoundaries.storedUser())).toBeNull();
  expect(await page.evaluate(() => window.__signupBoundaries.pkce())).toBeTruthy();
  expect(await page.evaluate(() => window.__signupBoundaries.events.filter(item => item.event === 'SIGNED_IN'))).toEqual([]);
  expect(await page.evaluate(() => window.__signupBoundaries.navigations)).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Check your signup request' })).toBeVisible();
});
