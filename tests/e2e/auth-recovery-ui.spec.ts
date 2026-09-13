import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Real RecoveryForm/LoginForm, locale/shared controls, production browser factory,
// installed SSR cookie adapters and auth SDK. Signed-grant server actions are a
// controlled typed boundary; their provider verification executes separately.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const isolated = new Set(['react', 'lucide-react', 'next/link', 'next/navigation', '@/components/auth/oauth-buttons', '@/components/auth/phone-auth',
  '@/app/(auth)/actions', '@/app/(auth)/auth/recovery/actions', '@/components/ui/toast', '@/lib/utils/cn']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve([filename, `${filename}.ts`, `${filename}.tsx`].find(p => fs.existsSync(p) && fs.statSync(p).isFile()) ?? filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = id.endsWith('.json') ? `module.exports = { default: ${JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw)).filter(([key]) => /^(authRecovery\.|login\.|loginForm\.|signup\.|signupForm\.|legalConsent\.)/.test(key))))} };`
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
const entries = Object.fromEntries(['components/auth/recovery-form.tsx', 'components/auth/login-form.tsx', 'components/i18n/locale-provider.tsx',
  'lib/i18n/locales.ts', 'lib/supabase/client.ts'].map(file => [file, collect(file)]));
const origin = 'https://auth-recovery-fixture.invalid', provider = 'https://recovery-provider.invalid';
const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sidA = '11111111-1111-4111-8111-111111111111', sidB = '22222222-2222-4222-8222-222222222222';
const grant = 'Z3JhbnQtQS1zeW50aGV0aWM.c2lnbmF0dXJlLXN5bnRoZXRpYw', otherGrant = 'Z3JhbnQtQw.c2lnbmF0dXJlLUM';
const storageKey = 'bubaly.auth.recovery.grant.v1';
const handoff = 'a'.repeat(64);
type Account = 'A' | 'B';
type Action = 'prepare' | 'consume' | 'inspect' | 'save';
type Fixture = {
  calls: Array<{ action: Action; body: unknown[] }>;
  recover: Array<Record<string, unknown> & { redirect: string | null }>;
  userReads: string[];
  tokenRequests: Array<Record<string, unknown>>;
  held: Partial<Record<Action | 'user' | 'recover', boolean>>;
  fail: Partial<Record<Action, boolean>>;
  save: 'updated' | 'failed' | 'uncertain' | 'lost'; recoverMode: 'ok' | 'rejected' | 'lost';
  release: (kind: Action | 'user' | 'recover') => Promise<void>;
  reload: () => Promise<void>;
};
type Probe = { mount: () => void; retire: () => void; capture: () => void; fire: (times?: number) => void; settle: () => Promise<void>;
  signIn: (account: Account) => Promise<void>; rotate: () => Promise<void>; user: () => Promise<string | null>; factoryHashes: string[]; errors: string[]; storage: () => Record<string, string>; seedGrant: (value: string) => void;
  installers: Array<{ reads: number; ambientReads: number; writes: number; disposed: boolean }> };
declare global { interface Window { __recoveryUi: Probe } }
function user(account: Account) { return { id: account === 'A' ? userA : userB, email: `${account.toLowerCase()}@example.invalid`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' }; }
function session(account: Account, rotation = 'original', expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: user(account).id,
    session_id: account === 'A' ? sidA : sidB, exp: now + expiresIn, iat: now, aud: 'authenticated', rotation })).toString('base64url'), 'synthetic-signature'].join('.');
  return { access_token: token, refresh_token: `synthetic-refresh-${account}-${rotation}`, token_type: 'bearer', expires_in: expiresIn, expires_at: now + expiresIn, user: user(account) };
}
const implicit = () => new URLSearchParams({ type: 'recovery', access_token: session('A').access_token, refresh_token: 'synthetic-refresh-input' }).toString();
async function fixture(page: Page, options: { hash?: string; query?: string; existing?: Account; existingExpiresIn?: number; stored?: string; request?: boolean; login?: boolean; locale?: string; strict?: boolean; hold?: Fixture['held']; mount?: boolean } = {}): Promise<Fixture> {
  const pending = new Map<string, Array<() => Promise<void>>>();
  const state: Fixture = { calls: [], recover: [], userReads: [], tokenRequests: [], held: { ...options.hold }, fail: {}, save: 'updated', recoverMode: 'ok',
    reload: async () => {},
    release: async kind => { delete state.held[kind]; await Promise.all((pending.get(kind) ?? []).splice(0).map(finish => finish())); } };
  const schedule = async (kind: Action | 'user' | 'recover', finish: () => Promise<void>) => {
    if (state.held[kind]) { const queue = pending.get(kind) ?? []; queue.push(finish); pending.set(kind, queue); } else await finish();
  };
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin && !url.pathname.startsWith('/fixture-actions/')) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }); return; }
    if (url.origin === origin) {
      const action = url.pathname.split('/').at(-1) as Action, body = req.postDataJSON() as unknown[];
      if (!['prepare', 'consume', 'inspect', 'save'].includes(action)) throw new Error(`Unexpected action ${action}`);
      state.calls.push({ action, body });
      await schedule(action, async () => {
        const identity = { userId: userA, sessionId: sidA, email: 'a@example.invalid', expiresAt: Date.now() + 15 * 60_000 };
        const result = state.fail[action] ? { ok: false, errorKey: 'authRecovery.invalidLink' }
          : action === 'save' ? { outcome: state.save, ...(state.save === 'failed' ? { errorKey: 'authRecovery.weakPassword' } : {}) }
            : { ok: true, identity, ...(action === 'inspect' ? {} : { grant }), ...(action === 'prepare' ? { session: session('A', 'prepared') } : {}) };
        await route.fulfill({ status: action === 'save' && state.save === 'lost' ? 502 : 200, contentType: 'application/json', body: JSON.stringify(result) });
      }); return;
    }
    if (url.origin !== provider) throw new Error(`Unexpected fixture destination ${url.origin}`);
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/token') {
      const body = req.postDataJSON(); state.tokenRequests.push(body);
      const account: Account = body.email === 'b@example.invalid' || body.refresh_token?.includes('-B-') ? 'B' : 'A';
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(session(account, body.refresh_token ? 'rotated' : 'signin', options.existingExpiresIn)) }); return;
    }
    if (url.pathname === '/auth/v1/user') {
      const token = req.headers().authorization?.slice(7) ?? '', payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      const account: Account = payload.sub === userA ? 'A' : 'B'; state.userReads.push(account);
      await schedule('user', () => route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(user(account)) })); return;
    }
    if (url.pathname === '/auth/v1/recover') {
      state.recover.push({ ...req.postDataJSON(), redirect: url.searchParams.get('redirect_to') });
      await schedule('recover', () => route.fulfill({ status: state.recoverMode === 'ok' ? 200 : state.recoverMode === 'rejected' ? 400 : 503,
        contentType: 'application/json', headers, body: JSON.stringify(state.recoverMode === 'ok' ? {} : { msg: 'Fixture recovery request failed' }) })); return;
    }
    throw new Error(`Unexpected provider request ${url.pathname}`);
  });
  await page.clock.install();
  const pathname = options.login ? '/login' : '/auth/recovery';
  const query = options.query ? `?${options.query}` : '';
  const hash = options.hash ? `#${options.hash}` : '';
  await page.goto(origin + pathname + query + (options.existing ? '' : hash));
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  const locale = options.locale ?? 'en-US';
  const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8'))).filter(([key]) => /^(authRecovery\.|login\.|loginForm\.|signup\.|signupForm\.|legalConsent\.)/.test(key)));
  const bootstrap = `(() => {
    const sources = ${JSON.stringify(modules)}, entries = ${JSON.stringify(entries)}, loaded = {}, messages = ${JSON.stringify(messages)};
    const p = window.__recoveryUi = { errors: [], factoryHashes: [], installers: [] }; let show = true, root, captured, jobs = [];
    window.addEventListener('error', e => p.errors.push(e.message)); window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    const action = async (name, values) => { const response = await fetch('/fixture-actions/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) }); if (!response.ok) throw new Error('Fixture action response lost'); return response.json(); };
    const mocks = { react: React, '@supabase/supabase-js': window.supabase, 'lucide-react': new Proxy({}, { get: () => () => null }),
      'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
      'next/navigation': { useSearchParams: () => new URLSearchParams(location.search), useRouter: () => ({ push() {}, refresh() {} }) },
      '@/components/auth/oauth-buttons': { OAuthButtons: () => null, authButtonClass: '' }, '@/components/auth/phone-auth': { PhoneAuth: () => null },
      '@/components/ui/toast': { useToast: () => ({ error: message => p.errors.push(message) }) },
      '@/lib/utils/cn': { cn: (...values) => values.filter(v => typeof v === 'string').join(' ') },
      '@/app/(auth)/actions': { stitchIdentityAction: async () => {}, resolveLandingPathAction: async () => '/home' },
      '@/app/(auth)/auth/recovery/actions': { prepareRecoveryAction: (...values) => action('prepare', values), consumeRecoveryAction: (...values) => action('consume', values), inspectRecoveryAction: (...values) => action('inspect', values), saveRecoveryAction: (...values) => action('save', values) },
    };
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-fixture' } };
    function load(id) { if (id in mocks) return mocks[id]; if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module ' + id);
      const module = loaded[id] = { exports: {} }; new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process); return module.exports; }
    const ssrId = sources[entries['components/auth/recovery-form.tsx']].imports['@supabase/ssr'], ssr = load(ssrId), originalBrowserClient = ssr.createBrowserClient;
    // Observe the real cookie adapter and dispose method without replacing the
    // SDK's storage/session implementation or its asynchronous callbacks.
    const observedBrowserClient = (url, key, options) => {
      if (options?.isSingleton !== false) return originalBrowserClient(url, key, options);
      const observation = { reads: 0, ambientReads: 0, writes: 0, disposed: false }; p.installers.push(observation);
      const originalCookies = options.cookies;
      const client = originalBrowserClient(url, key, { ...options, cookies: { ...originalCookies,
        getAll: (...args) => { observation.reads++; const values = originalCookies.getAll(...args); if (values.some(cookie => cookie.name.includes('-auth-token'))) observation.ambientReads++; return values; },
        setAll: (...args) => { observation.writes++; return originalCookies.setAll(...args); },
      } });
      const dispose = client.auth.dispose.bind(client.auth);
      client.auth.dispose = async () => { await dispose(); observation.disposed = true; };
      return client;
    };
    loaded[ssrId].exports = { ...ssr, createBrowserClient: observedBrowserClient };
    const factory = load(entries['lib/supabase/client.ts']), original = factory.createClient;
    factory.createClient = () => { p.factoryHashes.push(location.hash); return original(); };
    const RecoveryForm = load(entries['components/auth/recovery-form.tsx']).RecoveryForm, LoginForm = load(entries['components/auth/login-form.tsx']).LoginForm;
    const LocaleProvider = load(entries['components/i18n/locale-provider.tsx']).LocaleProvider, locale = load(entries['lib/i18n/locales.ts']).localeOrDefault(${JSON.stringify(locale)});
    function render() { root ??= ReactDOM.createRoot(document.getElementById('root'));
      const content = React.createElement(LocaleProvider, { locale, source: 'default', messages }, show ? React.createElement(${options.login ? 'LoginForm' : 'RecoveryForm'}, ${JSON.stringify({ request: options.request ?? false })}) : React.createElement('p', null, 'Other route'));
      ReactDOM.flushSync(() => root.render(${options.strict ? 'React.createElement(React.StrictMode, null, content)' : 'content'})); }
    p.mount = () => { show = true; render(); }; p.retire = () => { show = false; render(); };
    p.capture = () => { const form = document.querySelector('form'), props = form[Object.keys(form).find(k => k.startsWith('__reactProps$'))]; captured = () => props.onSubmit({ preventDefault() {}, currentTarget: form }); };
    p.fire = (times = 1) => { for (let i = 0; i < times; i++) jobs.push(Promise.resolve(captured()).catch(e => p.errors.push(String(e)))); };
    p.settle = async () => { await Promise.all(jobs); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
    p.signIn = async account => { const result = await factory.createClient().auth.signInWithPassword({ email: account.toLowerCase() + '@example.invalid', password: 'synthetic-password' }); if (result.error) throw result.error; ${options.existingExpiresIn ? 'await factory.createClient().auth.stopAutoRefresh();' : ''} };
    p.rotate = async () => { const result = await factory.createClient().auth.refreshSession(); if (result.error) throw result.error; };
    p.user = async () => (await factory.createClient().auth.getSession()).data.session?.user.id ?? null;
    p.storage = () => Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)]));
    p.seedGrant = value => sessionStorage.setItem(${JSON.stringify(storageKey)}, value);
  })();`;
  await page.addScriptTag({ content: bootstrap });
  state.reload = async () => {
    await page.reload();
    for (const content of [react, reactDom, sdk, bootstrap]) await page.addScriptTag({ content });
    await page.evaluate(() => window.__recoveryUi.mount());
  };
  if (options.existing) { await page.evaluate(account => window.__recoveryUi.signIn(account), options.existing); await page.evaluate(href => history.replaceState(history.state, '', href), pathname + query + hash); }
  if (options.stored) await page.evaluate(value => window.__recoveryUi.seedGrant(value), options.stored);
  if (options.mount !== false) await page.evaluate(() => window.__recoveryUi.mount());
  return state;
}
const saves = (state: Fixture) => state.calls.filter(c => c.action === 'save');
async function ready(page: Page) { await expect(page.getByRole('button', { name: 'Save new password', exact: true })).toBeVisible(); }
async function password(page: Page) { await ready(page); await page.locator('input[name="password"]').fill('synthetic-new-password'); await page.locator('input[name="confirmation"]').fill('synthetic-new-password'); }
async function submit(page: Page, times = 1) { await page.evaluate(times => { window.__recoveryUi.capture(); window.__recoveryUi.fire(times); }, times); }
test.afterEach(async ({ page }) => { expect(await page.evaluate(() => window.__recoveryUi?.errors ?? [])).toEqual([]); });

test('implicit link is stripped before production client construction and only the signed grant is stored', async ({ page }) => {
  const state = await fixture(page, { hash: implicit() }); await ready(page);
  expect(new URL(page.url()).hash).toBe(''); expect(await page.evaluate(() => window.__recoveryUi.factoryHashes)).toEqual(['']);
  expect(state.calls.map(c => c.action)).toEqual(['prepare']); expect(state.userReads).toEqual(['A']);
  expect(await page.evaluate(() => window.__recoveryUi.storage())).toEqual({ [storageKey]: grant });
  expect(await page.evaluate(() => window.__recoveryUi.user())).toBe(userA);
});

test('valid callback handoff and stored-grant reload verify against the current session', async ({ page }) => {
  const state = await fixture(page, { query: `handoff=${handoff}`, existing: 'A' }); await ready(page);
  expect(state.calls).toEqual([{ action: 'consume', body: [handoff] }]);
  await page.evaluate(() => { window.__recoveryUi.retire(); history.replaceState(history.state, '', '/auth/recovery'); window.__recoveryUi.mount(); }); await ready(page);
  expect(state.calls.at(-1)).toEqual({ action: 'inspect', body: [grant] });
});

test('verified handoff is removed so a reload after bridge expiry inspects the retained grant', async ({ page }) => {
  const state = await fixture(page, { query: `handoff=${handoff}&keep=selection`, existing: 'A' }); await ready(page);
  expect(new URL(page.url()).search).toBe('?keep=selection');
  expect(state.calls.map(call => call.action)).toEqual(['consume']);
  await page.clock.fastForward(6 * 60_000); state.fail.consume = true;
  await state.reload(); await ready(page);
  expect(state.calls.map(call => call.action)).toEqual(['consume', 'inspect']);
  expect(state.calls[1].body).toEqual([grant]);
  expect(await page.evaluate(() => window.__recoveryUi.storage())).toEqual({ [storageKey]: grant });
});

for (const entry of [{ query: 'error=expired', hash: '' }, { query: '', hash: 'type=recovery&access_token=bad' }, { query: '', hash: 'type=recovery&type=recovery&access_token=x&refresh_token=y' }, { query: 'handoff=bad', hash: '' }]) {
  test(`explicit invalid entry cannot fall back to a saved grant: ${entry.query || entry.hash.split('&').slice(0, 2).join('&')}`, async ({ page }) => {
    const state = await fixture(page, { ...entry, existing: 'A', stored: grant });
    await expect(page.getByRole('alert')).toContainText('This recovery link is invalid'); expect(state.calls).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save new password' })).toHaveCount(0);
  });
}

test('existing session alone never authorizes password recovery', async ({ page }) => {
  const state = await fixture(page, { existing: 'A' }); await expect(page.getByRole('alert')).toContainText('This recovery link is invalid');
  expect(state.calls).toEqual([]); expect(await page.evaluate(() => window.__recoveryUi.user())).toBe(userA);
});

test('same-turn and retired password submits issue one save; success survives its former grant expiry', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), hold: { save: true } }); await password(page); await submit(page, 2);
  await expect.poll(() => saves(state).length).toBe(1); await expect(page.locator('input[name="password"]')).toBeDisabled();
  await state.release('save'); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible();
  await page.evaluate(() => window.__recoveryUi.fire()); await page.evaluate(() => window.__recoveryUi.settle()); expect(saves(state)).toHaveLength(1);
  expect(await page.evaluate(() => window.__recoveryUi.storage())).toEqual({});
  await page.clock.fastForward(16 * 60_000); await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible();
});

test('confirmed rejection preserves the password draft for deliberate correction and retry', async ({ page }) => {
  const state = await fixture(page, { hash: implicit() }); state.save = 'failed'; await password(page); await submit(page); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.getByRole('alert')).toHaveText('Choose a stronger password.'); await expect(page.locator('input[name="password"]')).toHaveValue('synthetic-new-password');
  state.save = 'updated'; await submit(page); await page.evaluate(() => window.__recoveryUi.settle()); await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible(); expect(saves(state)).toHaveLength(2);
});

for (const outcome of ['uncertain', 'lost'] as const) test(`${outcome} save result blocks repeat and removes reload authority`, async ({ page }) => {
  const state = await fixture(page, { hash: implicit() }); state.save = outcome; await password(page); await submit(page); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.getByRole('alert')).toContainText("We couldn't confirm the change"); await expect(page.getByRole('button', { name: 'Save new password' })).toHaveCount(0);
  await page.evaluate(() => window.__recoveryUi.fire()); await page.evaluate(() => window.__recoveryUi.settle()); expect(saves(state)).toHaveLength(1);
  expect(await page.evaluate(() => window.__recoveryUi.storage())).toEqual({});
});

test('password confirmation mismatch does not dispatch', async ({ page }) => {
  const state = await fixture(page, { hash: implicit() }); await password(page); await page.locator('input[name="confirmation"]').fill('different'); await submit(page); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.getByRole('alert')).toHaveText('The passwords do not match.'); expect(saves(state)).toHaveLength(0);
});

test('held preparation released after unmount never starts session installation', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), existing: 'B', hold: { prepare: true } }); await expect.poll(() => state.calls.length).toBe(1);
  await page.evaluate(() => window.__recoveryUi.retire()); await state.release('prepare'); await page.evaluate(() => window.__recoveryUi.settle());
  expect(state.userReads).toEqual([]); expect(await page.evaluate(() => window.__recoveryUi.user())).toBe(userB);
});

test('held installed-SDK user lookup cannot write recovery cookies after unmount', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), existing: 'B', hold: { user: true } }); await expect.poll(() => state.userReads.length).toBe(1);
  await page.evaluate(() => window.__recoveryUi.retire()); await state.release('user'); await page.evaluate(() => window.__recoveryUi.settle());
  expect(await page.evaluate(() => window.__recoveryUi.user())).toBe(userB); expect(await page.evaluate(() => window.__recoveryUi.storage())).toEqual({});
});

test('recovery installer does not initialize ambient storage or start another renewal loop', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), existing: 'B', hold: { user: true } });
  await expect.poll(() => state.userReads.length).toBe(1);
  expect(state.userReads).toEqual(['A']);
  expect(await page.evaluate(() => window.__recoveryUi.installers)).toEqual([{ reads: 2, ambientReads: 0, writes: 0, disposed: false }]);
  expect(state.tokenRequests).toHaveLength(1);
  await state.release('user'); await ready(page);
  await expect.poll(() => page.evaluate(() => window.__recoveryUi.installers[0]?.disposed)).toBe(true);
  const finished = await page.evaluate(() => window.__recoveryUi.installers);
  await page.clock.fastForward(2 * 60_000); await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(await page.evaluate(() => window.__recoveryUi.installers)).toEqual(finished);
  expect(state.tokenRequests).toHaveLength(1); expect(await page.evaluate(() => window.__recoveryUi.user())).toBe(userA);
});

test('held installed-SDK user lookup cannot overwrite a newer sign-in', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), hold: { user: true } }); await expect.poll(() => state.userReads.length).toBe(1);
  await page.evaluate(() => window.__recoveryUi.signIn('B')); await state.release('user'); await page.evaluate(() => window.__recoveryUi.settle());
  expect(await page.evaluate(() => window.__recoveryUi.user())).toBe(userB); await expect(page.getByRole('button', { name: 'Save new password' })).toHaveCount(0);
});

test('account switch retires a ready form and its retained submit', async ({ page }) => {
  const state = await fixture(page, { hash: implicit() }); await password(page); await page.evaluate(() => window.__recoveryUi.capture());
  await page.evaluate(() => window.__recoveryUi.signIn('B')); await page.evaluate(() => window.__recoveryUi.fire()); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.getByRole('alert')).toContainText('The account changed'); expect(saves(state)).toHaveLength(0);
});

test('settled older save does not remove a newer stored grant', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), hold: { save: true } }); await password(page); await submit(page); await expect.poll(() => saves(state).length).toBe(1);
  await page.evaluate(value => window.__recoveryUi.seedGrant(value), otherGrant); await state.release('save'); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible(); expect(await page.evaluate(() => window.__recoveryUi.storage())).toEqual({ [storageKey]: otherGrant });
});

test('strict-mode preparation happens once and remains usable', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), strict: true }); await ready(page); expect(state.calls.filter(c => c.action === 'prepare')).toHaveLength(1); await password(page); await submit(page); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible();
});

test('a 35-second lost save acknowledgement becomes uncertain and a late response cannot report success', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), hold: { save: true } }); await password(page); await submit(page); await expect.poll(() => saves(state).length).toBe(1);
  await page.clock.fastForward(35_001); await expect(page.getByRole('alert')).toContainText("We couldn't confirm the change");
  await state.release('save'); await page.evaluate(() => window.__recoveryUi.settle()); await expect(page.getByRole('heading', { name: 'Password updated' })).toHaveCount(0); expect(saves(state)).toHaveLength(1);
});

test('self-service reset uses the SDK, normalized email, callback recovery target, and one request', async ({ page }) => {
  const state = await fixture(page, { login: true, query: 'reset=1', hold: { recover: true } });
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible(); await page.locator('input[name="email"]').fill('A@EXAMPLE.INVALID'); await submit(page, 2);
  await expect.poll(() => state.recover.length).toBe(1); expect(state.recover[0]).toMatchObject({ email: 'a@example.invalid', redirect: `${origin}/auth/callback?next=/auth/recovery`, code_challenge_method: 's256' });
  await state.release('recover'); await page.evaluate(() => window.__recoveryUi.settle()); await expect(page.getByRole('status')).toContainText('If this email belongs to an account');
  await page.evaluate(() => window.__recoveryUi.fire()); await page.evaluate(() => window.__recoveryUi.settle()); expect(state.recover).toHaveLength(1);
});

test('self-service lost email response reports uncertainty without a resend control', async ({ page }) => {
  const state = await fixture(page, { request: true }); state.recoverMode = 'lost'; await page.locator('input[name="email"]').fill('a@example.invalid'); await submit(page); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.getByRole('alert')).toContainText("We couldn't confirm the email request"); await expect(page.getByRole('button', { name: 'Send recovery link' })).toHaveCount(0);
  await page.evaluate(() => window.__recoveryUi.fire()); await page.evaluate(() => window.__recoveryUi.settle()); expect(state.recover).toHaveLength(1);
});

test('legacy login recovery fragment is consumed by the recovery form before SDK initialization', async ({ page }) => {
  const state = await fixture(page, { login: true, hash: implicit() }); await ready(page); expect(state.calls.map(c => c.action)).toEqual(['prepare']);
  expect(await page.evaluate(() => window.__recoveryUi.factoryHashes)).toEqual(['']); expect(new URL(page.url()).hash).toBe('');
});

test('French verified-account form and success use the real catalogue', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), locale: 'fr-FR' }); const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/fr-FR.json', 'utf8'));
  await expect(page.getByRole('heading', { name: messages['authRecovery.title'] })).toBeVisible(); await expect(page.locator('input[name="password"]')).toBeVisible();
  await page.locator('input[name="password"]').fill('synthetic-new-password'); await page.locator('input[name="confirmation"]').fill('synthetic-new-password'); await submit(page); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.getByRole('heading', { name: messages['authRecovery.updatedTitle'] })).toBeVisible(); expect(saves(state)).toHaveLength(1);
});

test('installer bootstrap cannot renew an ambient session that becomes refresh-eligible during preparation', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), existing: 'B', existingExpiresIn: 100, hold: { prepare: true, user: true } });
  await expect.poll(() => state.calls.length).toBe(1);
  // The unchanged singleton is explicitly paused only in this fixture to make
  // the temporary installer's traffic attributable. B enters the SDK margin.
  await page.clock.fastForward(30_000); await state.release('prepare');
  await expect.poll(() => state.userReads.length).toBe(1);
  expect(state.userReads).toEqual(['A']); expect(state.tokenRequests).toHaveLength(1);
  expect(state.tokenRequests[0]).not.toHaveProperty('refresh_token');
  expect(await page.evaluate(() => window.__recoveryUi.installers[0].ambientReads)).toBe(0);
  await state.release('user'); await ready(page); expect(await page.evaluate(() => window.__recoveryUi.user())).toBe(userA);
});

test('timed-out session installation cannot write cookies when its user lookup later completes', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), existing: 'B', hold: { user: true } });
  await expect.poll(() => state.userReads.length).toBe(1); await page.clock.fastForward(35_001);
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await state.release('user'); await page.evaluate(() => window.__recoveryUi.settle());
  expect(await page.evaluate(() => window.__recoveryUi.user())).toBe(userB);
  expect(await page.evaluate(() => window.__recoveryUi.storage())).toEqual({});
});

test('same-session token rotation preserves the current password draft and authority', async ({ page }) => {
  const state = await fixture(page, { hash: implicit() }); await password(page);
  await page.evaluate(() => window.__recoveryUi.rotate());
  expect(state.tokenRequests.at(-1)).toHaveProperty('refresh_token', 'synthetic-refresh-A-prepared');
  await expect(page.locator('input[name="password"]')).toHaveValue('synthetic-new-password');
  await submit(page); await page.evaluate(() => window.__recoveryUi.settle());
  expect(saves(state)).toHaveLength(1); await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible();
});

test('account switch during a dispatched password save suppresses its late success', async ({ page }) => {
  const state = await fixture(page, { hash: implicit(), hold: { save: true } }); await password(page); await submit(page);
  await expect.poll(() => saves(state).length).toBe(1); await page.evaluate(() => window.__recoveryUi.signIn('B'));
  await state.release('save'); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.getByRole('alert')).toContainText('The account changed');
  await expect(page.getByRole('heading', { name: 'Password updated' })).toHaveCount(0);
  expect(await page.evaluate(() => window.__recoveryUi.user())).toBe(userB);
});

for (const action of ['prepare', 'inspect'] as const) test(`rejected ${action} cannot fall back to the current session`, async ({ page }) => {
  const state = await fixture(page, { existing: 'A', stored: grant, ...(action === 'prepare' ? { hash: implicit() } : {}), mount: false });
  state.fail[action] = true; await page.evaluate(() => window.__recoveryUi.mount());
  await expect(page.getByRole('alert')).toContainText('This recovery link is invalid');
  expect(state.userReads).toEqual([]); expect(await page.evaluate(() => window.__recoveryUi.storage())).toEqual({});
  await expect(page.getByRole('button', { name: 'Save new password' })).toHaveCount(0);
});

test('invalid email stays local and a definitive request rejection preserves a deliberate retry', async ({ page }) => {
  const state = await fixture(page, { request: true }); await page.locator('input[name="email"]').fill('invalid');
  await submit(page); await page.evaluate(() => window.__recoveryUi.settle()); expect(state.recover).toHaveLength(0);
  await page.locator('input[name="email"]').fill('a@example.invalid'); state.recoverMode = 'rejected';
  await submit(page); await page.evaluate(() => window.__recoveryUi.settle());
  await expect(page.locator('input[name="email"]')).toHaveValue('a@example.invalid'); await expect(page.locator('input[name="email"]')).toBeEnabled();
  state.recoverMode = 'ok'; await submit(page); await page.evaluate(() => window.__recoveryUi.settle());
  expect(state.recover).toHaveLength(2); await expect(page.getByRole('status')).toContainText('If this email belongs to an account');
});

test('ordinary login exposes the self-service recovery entry', async ({ page }) => {
  await fixture(page, { login: true }); await expect(page.getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute('href', '/login?reset=1');
});
