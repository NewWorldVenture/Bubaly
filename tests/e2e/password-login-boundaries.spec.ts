import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Real LoginForm/React, shared controls/providers, password helper and installed
// SSR/auth SDK. Provider HTTP and server-action/navigation outcomes are fixtures.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const isolated = new Set(['react', 'lucide-react', 'next/link', 'next/navigation', '@/components/auth/oauth-buttons',
  '@/components/auth/phone-auth', '@/components/auth/recovery-form', '@/app/(auth)/actions', '@/lib/utils/cn', '@capacitor/core', '@capacitor/haptics']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve([filename, `${filename}.ts`, `${filename}.tsx`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = id.endsWith('.json') ? `module.exports = { default: ${JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw))
    .filter(([key]) => /^(login\.|loginForm\.|legalConsent\.|toast\.|authRecovery\.)/.test(key))))} };`
    : /\.tsx?$/.test(id) ? ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name) || name === '@supabase/supabase-js') { item.imports[name] = name; continue; }
    const target = name.startsWith('@/') ? path.resolve(name.slice(2)) : name.startsWith('.') && /\.tsx?$/.test(id)
      ? path.resolve(path.dirname(id), name) : require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries(['components/auth/login-form.tsx', 'components/ui/toast.tsx', 'components/i18n/locale-provider.tsx',
  'lib/i18n/locales.ts', 'lib/supabase/client.ts'].map(file => [file, collect(file)]));
const origin = 'https://password-login-fixture.invalid', provider = 'https://password-provider.invalid';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type Mode = 'session' | 'reject' | 'network' | 'malformed' | 'invalid-user' | 'invalid-token';
type Fixture = { mode: Mode; hold: boolean; requests: Array<Record<string, unknown>>; release: () => Promise<void> };
type Probe = {
  mount: (query?: string) => void; retire: () => void; capture: () => void; fire: (times?: number) => void; settle: () => Promise<void>;
  pending: number; errors: string[]; navigations: string[]; refreshes: number; stitches: number; landingCalls: number;
  landing: string; holdLanding: boolean; releaseLanding: () => void; rejectStitch: boolean; throwStitch: boolean;
  user: () => Promise<string | null>; signIn: (account: 'a' | 'b') => Promise<void>; oauthClicks: number; oauthDisabled: boolean;
};
declare global { interface Window { __passwordLogin: Probe } }
function user(id: string) { return { id, aud: 'authenticated', role: 'authenticated', email: `${id === A ? 'a' : 'b'}@example.invalid`, app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' }; }
function session(id: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return { access_token: [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: id, session_id: id === A ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', exp, aud: 'authenticated' })).toString('base64url'), 'synthetic-signature'].join('.'),
    refresh_token: `synthetic-refresh-${id}`, expires_at: exp, expires_in: 3600, token_type: 'bearer', user: user(id) };
}
async function fixture(page: Page, options: { mode?: Mode; hold?: boolean; query?: string; locale?: string } = {}): Promise<Fixture> {
  const pending: Array<() => Promise<void>> = [];
  const state: Fixture = { mode: options.mode ?? 'session', hold: options.hold ?? false, requests: [],
    release: async () => { state.hold = false; await Promise.all(pending.splice(0).map(finish => finish())); } };
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }); return; }
    if (url.origin !== provider) throw new Error(`Unexpected fixture destination: ${url.origin}`);
    if (request.method() === 'OPTIONS' || url.pathname === '/auth/v1/logout') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/user') {
      const token = request.headers().authorization?.replace(/^Bearer /, '') ?? '';
      const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(user(id)) }); return;
    }
    if (url.pathname !== '/auth/v1/token' || url.searchParams.get('grant_type') !== 'password') throw new Error(`Unexpected fixture request: ${url.pathname}`);
    const body = request.postDataJSON() as Record<string, unknown>; state.requests.push(body);
    const id = body.email === 'b@example.invalid' ? B : A, mode = state.mode;
    const finish = async () => {
      if (mode === 'network') { await route.abort('failed'); return; }
      const value = mode === 'reject' ? { code: 'invalid_credentials', message: 'Fixture invalid credentials' }
        : mode === 'malformed' ? {} : mode === 'invalid-user' ? { ...session(id), user: { ...user(id), id: 'invalid-user' } }
          : mode === 'invalid-token' ? { ...session(id), access_token: '   ' } : session(id);
      await route.fulfill({ status: mode === 'reject' ? 400 : 200, contentType: 'application/json', headers, body: JSON.stringify(value) });
    };
    if (state.hold) pending.push(finish); else await finish();
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  const locale = options.locale ?? 'en-US';
  const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')))
    .filter(([key]) => /^(login\.|loginForm\.|legalConsent\.|toast\.|authRecovery\.)/.test(key)));
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, loaded = {}, entries = ${JSON.stringify(entries)}, messages = ${JSON.stringify(messages)};
    const p = window.__passwordLogin = { errors: [], navigations: [], refreshes: 0, stitches: 0, landingCalls: 0, landing: '/home',
      holdLanding: false, pending: 0, rejectStitch: false, throwStitch: false, oauthClicks: 0, oauthDisabled: false };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    document.addEventListener('click', event => { if (event.target.closest('a')) event.preventDefault(); });
    let query = ${JSON.stringify(options.query ?? '')}, show = true, root, captured, jobs = [], releaseLanding;
    const router = { push: href => p.navigations.push(href), refresh: () => { p.refreshes++; } };
    const mocks = { react: React, '@supabase/supabase-js': window.supabase,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
      'next/navigation': { useRouter: () => router, useSearchParams: () => new URLSearchParams(query) },
      '@/components/auth/oauth-buttons': { authButtonClass: '', OAuthButtons: () => React.createElement('button', { type: 'button', disabled: p.oauthDisabled, onClick: () => p.oauthClicks++, 'data-testid': 'google' }, 'Continue with Google') },
      '@/components/auth/phone-auth': { PhoneAuth: ({ onBack }) => React.createElement('button', { onClick: onBack, 'data-testid': 'phone' }, 'Back from phone') },
      '@/components/auth/recovery-form': { RecoveryForm: () => React.createElement('p', { 'data-testid': 'recovery' }, 'Password recovery') },
      '@/app/(auth)/actions': {
        stitchIdentityAction: () => { p.stitches++; if (p.throwStitch) throw new Error('Fixture optional stitch'); return p.rejectStitch ? Promise.reject(new Error('Fixture optional stitch')) : Promise.resolve(); },
        resolveLandingPathAction: async () => { p.landingCalls++; if (p.holdLanding) await new Promise(resolve => { releaseLanding = resolve; }); return p.landing; },
      },
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
    const LoginForm = load(entries['components/auth/login-form.tsx']).LoginForm;
    const ToastProvider = load(entries['components/ui/toast.tsx']).ToastProvider;
    const LocaleProvider = load(entries['components/i18n/locale-provider.tsx']).LocaleProvider;
    const db = load(entries['lib/supabase/client.ts']).createClient();
    function render() {
      root ??= ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(LocaleProvider, { locale: ${JSON.stringify(locale)}, source: 'default', messages },
        React.createElement(ToastProvider, null, show ? React.createElement(LoginForm) : React.createElement('p', null, 'Other route')))));
    }
    p.mount = value => { if (value !== undefined) query = value; show = true; render(); };
    p.retire = () => { show = false; render(); };
    p.capture = () => { const form = document.querySelector('form'); const submit = form[Object.keys(form).find(key => key.startsWith('__reactProps$'))].onSubmit; captured = () => submit({ preventDefault() {}, currentTarget: form }); };
    p.fire = (times = 1) => { for (let i = 0; i < times; i++) { p.pending++; jobs.push(Promise.resolve(captured()).catch(error => p.errors.push(String(error))).finally(() => { p.pending--; })); } };
    p.settle = async () => { await Promise.all(jobs); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
    p.user = async () => (await db.auth.getSession()).data.session?.user.id ?? null;
    p.signIn = async account => { const { error } = await db.auth.signInWithPassword({ email: account + '@example.invalid', password: 'synthetic-password' }); if (error) throw error; };
    p.releaseLanding = () => { p.holdLanding = false; releaseLanding(); };
    p.mount();
  })();` });
  return state;
}
async function fill(page: Page) { await page.locator('input[name="email"]').fill('A@EXAMPLE.INVALID'); await page.locator('input[name="password"]').fill('synthetic-password'); }
async function submit(page: Page, count = 1) { await page.evaluate(count => { const p = window.__passwordLogin; p.capture(); p.fire(count); }, count); }
async function settled(page: Page) { await page.evaluate(() => window.__passwordLogin.settle()); }
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('successful password login persists the actual session and prefers a safe invite over plan selection', async ({ page }) => {
  const state = await fixture(page, { query: 'redirect=%2Fjoin%3Ftoken%3Dfixture&reviewPlan=plus_annual' }); await fill(page); await submit(page); await settled(page);
  expect(state.requests).toHaveLength(1); expect(state.requests[0]).toMatchObject({ email: 'a@example.invalid', password: 'synthetic-password' });
  expect(await page.evaluate(() => ({ navigations: window.__passwordLogin.navigations, refreshes: window.__passwordLogin.refreshes }))).toEqual({ navigations: ['/join?token=fixture'], refreshes: 1 });
  expect(await page.evaluate(() => window.__passwordLogin.user())).toBe(A);
  expect(await page.evaluate(() => window.__passwordLogin.landingCalls)).toBe(0);
});

for (const destination of ['/home', '/admin', '/grandparent']) test(`ordinary password login resolves ${destination} after its session is saved`, async ({ page }) => {
  await fixture(page); await page.evaluate(destination => { window.__passwordLogin.landing = destination; }, destination);
  await fill(page); await submit(page); await settled(page);
  expect(await page.evaluate(() => window.__passwordLogin.navigations)).toEqual([destination]);
  expect(await page.evaluate(() => window.__passwordLogin.landingCalls)).toBe(1);
});

test('same-turn duplicate and post-completion retained submissions issue one request', async ({ page }) => {
  const state = await fixture(page, { hold: true }); await fill(page); await submit(page, 2);
  await expect.poll(() => state.requests.length).toBe(1);
  await expect(page.locator('input[name="email"]')).toBeDisabled(); await expect(page.locator('input[name="password"]')).toBeDisabled();
  await state.release(); await settled(page); await page.evaluate(() => window.__passwordLogin.fire()); await settled(page);
  expect(state.requests).toHaveLength(1); expect(await page.evaluate(() => window.__passwordLogin.navigations)).toEqual(['/home']);
});

test('invalid fields display errors without calling the provider', async ({ page }) => {
  const state = await fixture(page); await page.locator('input[name="email"]').fill('not-an-email'); await submit(page); await settled(page);
  expect(state.requests).toHaveLength(0); expect(await page.evaluate(() => window.__passwordLogin.navigations)).toEqual([]);
  await expect(page.locator('input[name="email"]')).toBeEnabled();
});

for (const boundary of ['unmount', 'destination', 'phone', 'google', 'recovery', 'signup', 'kid'] as const) test(`${boundary} change retires delayed password adoption and stale navigation`, async ({ page }) => {
  const state = await fixture(page, { hold: true }); await fill(page); await submit(page);
  await expect.poll(() => state.requests.length).toBe(1);
  if (boundary === 'unmount') await page.evaluate(() => window.__passwordLogin.retire());
  else if (boundary === 'destination') await page.evaluate(() => window.__passwordLogin.mount('redirect=%2Fjoin%3Ftoken%3Dnew'));
  else if (boundary === 'phone') await page.getByRole('button', { name: 'Continue with phone', exact: true }).click();
  else if (boundary === 'google') await page.getByTestId('google').click();
  else await page.locator(`a[href="${boundary === 'recovery' ? '/login?reset=1' : boundary === 'signup' ? '/signup' : '/kid-login'}"]`).click();
  await state.release(); await settled(page);
  expect(await page.evaluate(() => window.__passwordLogin.user())).toBeNull();
  expect(await page.evaluate(() => ({ nav: window.__passwordLogin.navigations, stitch: window.__passwordLogin.stitches, errors: window.__passwordLogin.errors }))).toEqual({ nav: [], stitch: 0, errors: [] });
});

test('a retained callback from an old destination cannot issue a request', async ({ page }) => {
  const state = await fixture(page); await fill(page); await page.evaluate(() => { const p = window.__passwordLogin; p.capture(); p.mount('redirect=%2Fnew'); p.fire(); }); await settled(page);
  expect(state.requests).toHaveLength(0);
});

for (const gesture of ['ctrl', 'meta', 'shift', 'alt', 'middle', 'prevented'] as const) test(`${gesture} anchor click preserves password login in the current tab`, async ({ page }) => {
  const state = await fixture(page, { hold: true }); await fill(page); await submit(page);
  await expect.poll(() => state.requests.length).toBe(1);
  if (gesture === 'prevented') await page.evaluate(() => {
    document.addEventListener('click', event => event.preventDefault(), { capture: true, once: true });
  });
  await page.locator('a[href="/signup"]').dispatchEvent('click', {
    button: gesture === 'middle' ? 1 : 0, ctrlKey: gesture === 'ctrl', metaKey: gesture === 'meta', shiftKey: gesture === 'shift', altKey: gesture === 'alt',
  });
  await state.release(); await settled(page);
  expect(await page.evaluate(() => window.__passwordLogin.user())).toBe(A);
  expect(await page.evaluate(() => window.__passwordLogin.navigations)).toEqual(['/home']);
  expect(await page.evaluate(() => window.__passwordLogin.errors)).toEqual([]);
});

for (const target of ['padding', 'disabled-provider'] as const) test(`OAuth ${target} click preserves the pending password login`, async ({ page }) => {
  const state = await fixture(page, { hold: true }); await fill(page); await submit(page);
  await expect.poll(() => state.requests.length).toBe(1);
  if (target === 'padding') await page.getByTestId('google').locator('..').dispatchEvent('click');
  else {
    await page.evaluate(() => { window.__passwordLogin.oauthDisabled = true; window.__passwordLogin.mount(); });
    await page.getByTestId('google').dispatchEvent('click');
  }
  await state.release(); await settled(page);
  expect(await page.evaluate(() => window.__passwordLogin.user())).toBe(A);
  expect(await page.evaluate(() => window.__passwordLogin.navigations)).toEqual(['/home']);
  expect(await page.evaluate(() => window.__passwordLogin.oauthClicks)).toBe(0);
});

test('a delayed password response cannot replace B saved in another tab', async ({ page, context }) => {
  const state = await fixture(page, { hold: true }); await fill(page); await submit(page); await expect.poll(() => state.requests.length).toBe(1);
  const other = await context.newPage(); await fixture(other); await other.evaluate(() => window.__passwordLogin.signIn('b'));
  await state.release(); await settled(page);
  expect(await page.evaluate(() => window.__passwordLogin.user())).toBe(B);
  expect(await page.evaluate(() => window.__passwordLogin.navigations)).toEqual([]);
  expect(await page.evaluate(() => window.__passwordLogin.stitches)).toBe(0);
});

test('B arriving during a held landing lookup suppresses A navigation', async ({ page, context }) => {
  await fixture(page); await page.evaluate(() => { window.__passwordLogin.holdLanding = true; }); await fill(page); await submit(page);
  await expect.poll(() => page.evaluate(() => window.__passwordLogin.landingCalls)).toBe(1);
  const other = await context.newPage(); await fixture(other); await other.evaluate(() => window.__passwordLogin.signIn('b'));
  await page.evaluate(() => window.__passwordLogin.releaseLanding()); await settled(page);
  expect(await page.evaluate(() => window.__passwordLogin.user())).toBe(B);
  expect(await page.evaluate(() => window.__passwordLogin.navigations)).toEqual([]);
  expect(await page.evaluate(() => window.__passwordLogin.errors)).toEqual([]);
});

for (const mode of ['reject', 'network', 'malformed', 'invalid-user', 'invalid-token'] as const) test(`${mode} response cannot navigate and allows a deliberate valid retry`, async ({ page }) => {
  const state = await fixture(page, { mode }); await fill(page); await submit(page); await settled(page);
  expect(await page.evaluate(() => window.__passwordLogin.navigations)).toEqual([]);
  expect(await page.evaluate(() => window.__passwordLogin.user())).toBeNull();
  state.mode = 'session'; await submit(page); await settled(page);
  expect(await page.evaluate(() => window.__passwordLogin.navigations)).toEqual(['/home']);
});

for (const mode of ['rejectStitch', 'throwStitch'] as const) test(`optional ${mode} does not fail login or leak an unhandled promise`, async ({ page }) => {
  await fixture(page); await page.evaluate(mode => { window.__passwordLogin[mode] = true; }, mode); await fill(page); await submit(page); await settled(page);
  expect(await page.evaluate(() => window.__passwordLogin.navigations)).toEqual(['/home']);
  expect(await page.evaluate(() => window.__passwordLogin.errors)).toEqual([]);
});
