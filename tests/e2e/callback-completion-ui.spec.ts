import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Production React completion/recovery forms, cookie adapters and installed
// provider SDK. Server actions are a typed transport seam exercised separately
// with the installed server SDK; no application server or live provider is used.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const isolated = new Set(['react', 'lucide-react', 'next/link', 'next/navigation', '@/lib/utils/cn',
  '@/app/(auth)/auth/complete/actions', '@/app/(auth)/auth/recovery/actions']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve([filename, `${filename}.ts`, `${filename}.tsx`].find(file => fs.existsSync(file) && fs.statSync(file).isFile()) ?? filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = id.endsWith('.json') ? `module.exports = { default: ${JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw)).filter(([key]) => /^(authCallback\.|authRecovery\.|signup\.|signupForm\.|login\.)/.test(key))))} };`
    : /\.tsx?$/.test(id) ? ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name) || name === '@supabase/supabase-js') { item.imports[name] = name; continue; }
    item.imports[name] = collect(name.startsWith('@/') ? path.resolve(name.slice(2)) : name.startsWith('.') && /\.tsx?$/.test(id)
      ? path.resolve(path.dirname(id), name) : require.resolve(name, { paths: [path.dirname(id)] }));
  }
  return id;
}
const entries = Object.fromEntries(['components/auth/callback-completion.tsx', 'components/i18n/locale-provider.tsx', 'lib/i18n/locales.ts',
  'lib/auth/browser-signout.ts', 'lib/auth/password-client.ts', 'lib/supabase/client.ts', 'lib/auth/callback-witness.ts'].map(file => [file, collect(file)]));
const origin = 'https://callback-ui.invalid', provider = 'https://callback-provider.invalid';
const cookieKey = 'sb-callback-provider-auth-token', grantKey = 'bubaly.auth.recovery.grant.v1';
const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sidA = '11111111-1111-4111-8111-111111111111', sidB = '22222222-2222-4222-8222-222222222222';
const grant = 'Z3JhbnQtQS1zeW50aGV0aWM.c2lnbmF0dXJlLXN5bnRoZXRpYw';
function user(account: 'A' | 'B') { return { id: account === 'A' ? userA : userB, email: `${account.toLowerCase()}@example.invalid`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' }; }
function session(account: 'A' | 'B', rotation = 'callback') {
  const now = Math.floor(Date.now() / 1000);
  const access = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: user(account).id,
    session_id: account === 'A' ? sidA : sidB, exp: now + 3600, iat: now, iss: `${provider}/auth/v1`, aud: 'authenticated', role: 'authenticated', rotation })).toString('base64url'), 'synthetic-signature'].join('.');
  return { access_token: access, refresh_token: `synthetic-refresh-${account}-${rotation}`, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, user: user(account) };
}
type Kind = 'complete' | 'user';
type MalformedRecovery = 'missing-grant' | 'non-string-grant' | 'invalid-grant' | 'oversized-grant'
  | 'missing-identity' | 'wrong-user' | 'wrong-session' | 'expired-identity' | 'invalid-email';
type Fixture = { calls: Array<{ name: string; values: unknown[] }>; held: Partial<Record<Kind, boolean>>; failUser: boolean; rejected: boolean; userReads: number;
  release: (kind: Kind) => Promise<void> };
type Probe = { errors: string[]; routes: string[]; mount: () => void; retire: () => void; login: (account: 'A' | 'B') => Promise<void>;
  logout: () => Promise<void>; user: () => Promise<string | null>; replaceVerifier: () => void; seedGrant: () => void; rotate: () => Promise<void>;
  prepareAdmission: () => Promise<void>; logoutWithVerifierRetained: () => Promise<void> };
declare global { interface Window { __callbackUi: Probe } }
async function fixture(page: Page, options: { hold?: Kind; recovery?: boolean; strict?: boolean; blockStorage?: boolean; noCode?: boolean;
  existing?: 'A' | 'B'; next?: string; locale?: string; visitorReset?: boolean; malformedRecovery?: MalformedRecovery;
  extraQuery?: Record<string, string>; hash?: string; beforeMount?: 'logout-retained' | 'login' | 'rotate' | 'logout'; admission?: string | null } = {}): Promise<Fixture> {
  const pending: Partial<Record<Kind, Array<() => Promise<void>>>> = {};
  const state: Fixture = { calls: [], held: options.hold ? { [options.hold]: true } : {}, failUser: false, rejected: false, userReads: 0,
    release: async kind => { delete state.held[kind]; await Promise.all((pending[kind] ?? []).splice(0).map(run => run())); } };
  const schedule = async (kind: Kind, fn: () => Promise<void>) => { if (state.held[kind]) (pending[kind] ??= []).push(fn); else await fn(); };
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  const next = options.recovery ? '/auth/recovery' : options.next ?? '/home';
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin && !url.pathname.startsWith('/fixture-actions/')) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }); return;
    }
    if (url.origin === origin) {
      const name = url.pathname.split('/').at(-1)!, values = req.postDataJSON() as unknown[];
      state.calls.push({ name, values });
      const identity = { userId: userA, sessionId: sidA, email: 'a@example.invalid', expiresAt: Date.now() + 15 * 60_000 };
      const recoveryReceipt: Record<string, unknown> = { grant, identity: { ...identity } };
      if (options.malformedRecovery === 'missing-grant') delete recoveryReceipt.grant;
      if (options.malformedRecovery === 'non-string-grant') recoveryReceipt.grant = { token: grant };
      if (options.malformedRecovery === 'invalid-grant') recoveryReceipt.grant = 'unsigned-value';
      if (options.malformedRecovery === 'oversized-grant') recoveryReceipt.grant = 'a'.repeat(2048) + '.b';
      if (options.malformedRecovery === 'missing-identity') recoveryReceipt.identity = null;
      if (options.malformedRecovery === 'wrong-user') recoveryReceipt.identity = { ...identity, userId: userB };
      if (options.malformedRecovery === 'wrong-session') recoveryReceipt.identity = { ...identity, sessionId: sidB };
      if (options.malformedRecovery === 'expired-identity') recoveryReceipt.identity = { ...identity, expiresAt: Date.now() - 1 };
      if (options.malformedRecovery === 'invalid-email') recoveryReceipt.identity = { ...identity, email: '' };
      const respond = () => route.fulfill({ contentType: 'application/json', body: JSON.stringify(name === 'complete'
        ? state.rejected ? { status: 'rejected', errorKey: 'authRecovery.invalidLink' }
          : { status: 'exchanged', tokens: session('A'), destination: next, visitorReset: options.visitorReset, ...(options.recovery ? { recovery: recoveryReceipt } : {}) }
        : name === 'save' ? { outcome: 'updated' } : { ok: true, identity }) });
      if (name === 'complete') await schedule('complete', respond); else await respond(); return;
    }
    if (url.origin !== provider) throw new Error('Unexpected fixture destination');
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/token') {
      const body = req.postDataJSON(), account = body.email === 'b@example.invalid' || body.refresh_token?.includes('-B-') ? 'B' : 'A';
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(session(account, body.refresh_token ? 'rotated' : 'password')) }); return;
    }
    if (url.pathname === '/auth/v1/user') {
      state.userReads++;
      const claims = JSON.parse(Buffer.from(req.headers().authorization!.slice(7).split('.')[1], 'base64url').toString());
      await schedule('user', () => route.fulfill({ status: state.failUser ? 503 : 200, contentType: 'application/json', headers,
        body: JSON.stringify(state.failUser ? { message: 'temporarily unavailable' } : user(claims.sub === userA ? 'A' : 'B')) })); return;
    }
    throw new Error('Unexpected provider endpoint');
  });
  await page.goto(`${origin}/auth/complete?next=${encodeURIComponent(next)}${options.noCode ? '' : '&code=synthetic-code'}${options.extraQuery ? '&' + new URLSearchParams(options.extraQuery) : ''}${options.hash ? '#' + options.hash : ''}`);
  await page.clock.install();
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(`lib/i18n/messages/${options.locale ?? 'en-US'}.json`, 'utf8')))
    .filter(([key]) => /^(authCallback\.|authRecovery\.|signup\.|signupForm\.|login\.)/.test(key)));
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, entries = ${JSON.stringify(entries)}, loaded = {};
    const p = window.__callbackUi = { errors: [], routes: [] }; let root, shown = true, admission = null;
    window.addEventListener('error', e => p.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    const action = async (name, values) => { const r = await fetch('/fixture-actions/' + name, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(values) }); return r.json(); };
    const mocks = { react: React, '@supabase/supabase-js': window.supabase, 'lucide-react': new Proxy({}, { get: () => () => null }),
      'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
      'next/navigation': { useSearchParams: () => new URLSearchParams(location.search), useRouter: () => ({ replace: url => p.routes.push(url) }) },
      '@/lib/utils/cn': { cn: (...values) => values.filter(v => typeof v === 'string').join(' ') },
      '@/app/(auth)/auth/complete/actions': { completeCallbackAction: (...values) => action('complete', values) },
      '@/app/(auth)/auth/recovery/actions': Object.fromEntries(['prepare','consume','inspect','save'].map(name => [name + 'RecoveryAction', (...values) => action(name, values)])) };
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-key' } };
    function load(id) { if (id in mocks) return mocks[id]; if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected module ' + id);
      const module = loaded[id] = {exports:{}}; new Function('require','module','exports','process',item.source)(name => load(item.imports[name]),module,module.exports,process); return module.exports; }
    const form = load(entries['components/auth/callback-completion.tsx']).CallbackCompletion;
    const locale = load(entries['lib/i18n/locales.ts']).localeOrDefault(${JSON.stringify(options.locale ?? 'en-US')});
    const LocaleProvider = load(entries['components/i18n/locale-provider.tsx']).LocaleProvider;
    const factory = load(entries['lib/supabase/client.ts']), password = load(entries['lib/auth/password-client.ts']), signout = load(entries['lib/auth/browser-signout.ts']);
    document.cookie = ${JSON.stringify(cookieKey + '-code-verifier=' + encodeURIComponent('base64-' + Buffer.from(JSON.stringify('synthetic-verifier')).toString('base64url')) + '; Path=/; Secure; SameSite=Lax')};
    document.cookie = 'bubaly_vid=visitor-original; Path=/; Secure';
    ${options.blockStorage ? "Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('Storage disabled'); } });" : ''}
    function render() { root ??= ReactDOM.createRoot(document.getElementById('root')); const content = React.createElement(LocaleProvider,{locale,source:'default',messages:${JSON.stringify(messages)}}, shown ? React.createElement(form,{...${JSON.stringify({ code: options.noCode ? null : 'synthetic-code', next })}, admission: ${options.admission === undefined ? 'admission' : JSON.stringify(options.admission)}}) : React.createElement('p',null,'Other route'));
      ReactDOM.flushSync(() => root.render(${options.strict ? 'React.createElement(React.StrictMode,null,content)' : 'content'})); }
    p.mount = () => { shown = true; render(); }; p.retire = () => { shown = false; render(); };
    p.login = async account => { const r = await password.signInWithOwnedSession({email:account.toLowerCase()+'@example.invalid',password:'synthetic-password'},()=>true); if(r.error) throw r.error; };
    p.logout = async () => { await signout.signOutBrowserSession(signout.captureSignOutIntent(),{revoke:false}); };
    p.user = async () => (await factory.createClient().auth.getSession()).data.session?.user.id ?? null;
    p.rotate = async () => { const r = await factory.createClient().auth.refreshSession(); if(r.error) throw r.error; };
    p.replaceVerifier = () => { document.cookie = ${JSON.stringify(cookieKey + '-code-verifier=newer-verifier; Path=/; Secure')}; };
    p.seedGrant = () => sessionStorage.setItem(${JSON.stringify(grantKey)},'newer.grant');
    p.prepareAdmission = async () => {
      const witness = load(entries['lib/auth/callback-witness.ts']);
      const ssr = load(sources[entries['lib/auth/callback-witness.ts']].imports['@supabase/ssr']);
      const material = witness.callbackAdmissionMaterial(ssr.parseCookieHeader(document.cookie).map(c => ({name:c.name,value:c.value ?? ''})), ${JSON.stringify(cookieKey)});
      const snapshot = {v:1};
      for (const [name,value] of Object.entries(material)) snapshot[name] = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
      admission = witness.encodeCallbackAdmissionWitness(snapshot);
    };
    p.logoutWithVerifierRetained = async () => {
      const original = Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
      Object.defineProperty(document,'cookie',{configurable:true,get:()=>original.get.call(document),set:value=>{
        if (!(String(value).startsWith(${JSON.stringify(cookieKey + '-code-verifier=')}) && /max-age=0/i.test(String(value)))) original.set.call(document,value);
      }});
      try { await p.logout(); } finally { delete document.cookie; }
    };
  })();` });
  if (options.existing) await page.evaluate(account => window.__callbackUi.login(account), options.existing);
  await page.evaluate(() => window.__callbackUi.prepareAdmission());
  if (options.beforeMount === 'logout-retained') await page.evaluate(() => window.__callbackUi.logoutWithVerifierRetained());
  if (options.beforeMount === 'logout') await page.evaluate(() => window.__callbackUi.logout());
  if (options.beforeMount === 'login') await page.evaluate(() => window.__callbackUi.login('B'));
  if (options.beforeMount === 'rotate') await page.evaluate(() => window.__callbackUi.rotate());
  await page.evaluate(() => window.__callbackUi.mount());
  return state;
}
test.afterEach(async ({ page }) => { expect(await page.evaluate(() => window.__callbackUi?.errors ?? [])).toEqual([]); });
const navigated = async (page: Page, target = '/home') => expect.poll(() => page.evaluate(() => window.__callbackUi.routes)).toEqual([target]);

test('completes once under Strict Mode, verifies tokens, consumes verifier and cleans the URL', async ({ page }) => {
  const state = await fixture(page, { strict: true }); await navigated(page);
  expect(state.calls.map(call => call.name)).toEqual(['complete']);
  expect(state.calls[0].values[0]).toMatchObject({ code: 'synthetic-code', next: '/home', verifierFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(new URL(page.url()).searchParams.has('code')).toBe(false);
  expect(await page.evaluate(() => window.__callbackUi.user())).toBe(userA);
  expect((await page.context().cookies()).some(cookie => cookie.name.includes('code-verifier'))).toBe(false);
});
for (const change of ['logout', 'login', 'verifier', 'unmount'] as const) {
  test(`a held completion cannot override ${change}`, async ({ page }) => {
    const state = await fixture(page, { hold: 'complete' }); await expect.poll(() => state.calls.length).toBe(1);
    if (change === 'logout') await page.evaluate(() => window.__callbackUi.logout());
    if (change === 'login') await page.evaluate(() => window.__callbackUi.login('B'));
    if (change === 'verifier') await page.evaluate(() => window.__callbackUi.replaceVerifier());
    if (change === 'unmount') await page.evaluate(() => window.__callbackUi.retire());
    await state.release('complete');
    if (change !== 'unmount') await expect(page.getByRole('alert')).toContainText('Your sign-in state changed');
    else await expect(page.getByText('Other route')).toBeVisible();
    expect(await page.evaluate(() => window.__callbackUi.routes)).toEqual([]);
    expect(await page.evaluate(() => window.__callbackUi.user())).toBe(change === 'login' ? userB : null);
  });
}
test('a newer recovery grant retires a held response without overwriting session or storage', async ({ page }) => {
  const state = await fixture(page, { recovery: true, hold: 'complete' }); await expect.poll(() => state.calls.length).toBe(1);
  await page.evaluate(() => window.__callbackUi.seedGrant()); await state.release('complete');
  await expect(page.getByRole('alert')).toContainText('Your sign-in state changed');
  expect(await page.evaluate(key => sessionStorage.getItem(key), grantKey)).toBe('newer.grant');
  expect(await page.evaluate(() => window.__callbackUi.user())).toBeNull();
});
test('recovery adoption persists only the signed grant and routes to the existing form', async ({ page }) => {
  await fixture(page, { recovery: true }); await navigated(page, '/auth/recovery');
  expect(await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).map(key => [key,sessionStorage.getItem(key)])))).toEqual({ [grantKey]: grant });
});
test('blocked session storage keeps a verified recovery form usable through password save', async ({ page }) => {
  const state = await fixture(page, { recovery: true, blockStorage: true });
  await expect(page.getByRole('button', { name: 'Save new password', exact: true })).toBeVisible();
  await page.locator('input[name="password"]').fill('synthetic-new-password');
  await page.locator('input[name="confirmation"]').fill('synthetic-new-password');
  await page.getByRole('button', { name: 'Save new password', exact: true }).click();
  await expect(page.getByRole('heading')).toContainText('Password updated');
  expect(state.calls.map(call => call.name)).toEqual(['complete','inspect','save']);
  expect(state.calls[2].values).toEqual([grant,'synthetic-new-password']);
});
test('a deliberate installation retry reuses the receipt without exchanging the code twice', async ({ page }) => {
  const state = await fixture(page, { hold: 'complete' }); await expect.poll(() => state.calls.length).toBe(1);
  state.failUser = true; await state.release('complete');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  state.failUser = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await navigated(page); expect(state.calls.filter(call => call.name === 'complete')).toHaveLength(1);
});
test('same-session rotation during the exchange preserves ownership', async ({ page }) => {
  const state = await fixture(page, { hold: 'complete', existing: 'A' }); await expect.poll(() => state.calls.length).toBe(1);
  await page.evaluate(() => window.__callbackUi.rotate()); await state.release('complete'); await navigated(page);
});
test('a missing code can continue an existing login through the guarded browser', async ({ page }) => {
  const state = await fixture(page, { noCode: true, existing: 'B', next: '/dashboard/meals?week=next' });
  await navigated(page, '/dashboard/meals?week=next'); expect(state.calls).toEqual([]);
  expect(await page.evaluate(() => window.__callbackUi.user())).toBe(userB);
});
test('failed recovery never adopts an ambient login as recovery authority', async ({ page }) => {
  const state = await fixture(page, { hold: 'complete', recovery: true, existing: 'B' }); await expect.poll(() => state.calls.length).toBe(1);
  state.rejected = true; await state.release('complete');
  await expect(page.getByRole('alert')).toContainText('This sign-in link is invalid');
  expect(state.calls.map(call => call.name)).toEqual(['complete']); expect(await page.evaluate(() => window.__callbackUi.user())).toBe(userB);
});
test('deadline retires late action receipts without a cookie write or navigation', async ({ page }) => {
  const state = await fixture(page, { hold: 'complete' }); await expect.poll(() => state.calls.length).toBe(1);
  await page.clock.fastForward(36_000); await expect(page.getByRole('alert')).toContainText('We could not finish');
  await state.release('complete'); expect(await page.evaluate(() => window.__callbackUi.routes)).toEqual([]);
  expect(await page.evaluate(() => window.__callbackUi.user())).toBeNull();
});
test('visitor fork rotates only after successful adoption', async ({ page }) => {
  const state = await fixture(page, { visitorReset: true, hold: 'complete' }); await expect.poll(() => state.calls.length).toBe(1);
  expect((await page.context().cookies()).find(cookie => cookie.name === 'bubaly_vid')?.value).toBe('visitor-original');
  await state.release('complete'); await navigated(page);
  expect((await page.context().cookies()).find(cookie => cookie.name === 'bubaly_vid')?.value).not.toBe('visitor-original');
});
test('mobile error renders localized text and a keyboard reachable return link', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 }); await fixture(page, { noCode: true, locale: 'es-ES' });
  await expect(page.getByRole('heading')).toHaveText('Completar el inicio de sesión');
  await expect(page.getByRole('alert')).toContainText('Este enlace no es válido');
  await page.keyboard.press('Tab'); await expect(page.getByRole('link')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const change of ['logout', 'login', 'verifier', 'unmount'] as const) {
  test(`final provider verification respects ${change} before the actual cookie write`, async ({ page }) => {
    const state = await fixture(page, { hold: 'user' }); await expect.poll(() => state.userReads).toBe(1);
    if (change === 'logout') await page.evaluate(() => window.__callbackUi.logout());
    if (change === 'login') await page.evaluate(() => window.__callbackUi.login('B'));
    if (change === 'verifier') await page.evaluate(() => window.__callbackUi.replaceVerifier());
    if (change === 'unmount') await page.evaluate(() => window.__callbackUi.retire());
    await state.release('user');
    if (change !== 'unmount') await expect(page.getByRole('alert')).toContainText('Your sign-in state changed');
    else await expect(page.getByText('Other route')).toBeVisible();
    expect(await page.evaluate(() => window.__callbackUi.routes)).toEqual([]);
    expect(await page.evaluate(() => window.__callbackUi.user())).toBe(change === 'login' ? userB : null);
  });
}
test('late rejected recovery cannot clear a newer grant', async ({ page }) => {
  const state = await fixture(page, { recovery: true, hold: 'complete' }); await expect.poll(() => state.calls.length).toBe(1);
  state.rejected = true; await page.evaluate(() => window.__callbackUi.seedGrant()); await state.release('complete');
  await expect(page.getByRole('alert')).toContainText('Your sign-in state changed');
  expect(await page.evaluate(key => sessionStorage.getItem(key), grantKey)).toBe('newer.grant');
});
test('a newer attribution identity survives an older successful fork receipt', async ({ page }) => {
  const state = await fixture(page, { visitorReset: true, hold: 'complete' }); await expect.poll(() => state.calls.length).toBe(1);
  await page.evaluate(() => { document.cookie = 'bubaly_vid=visitor-newer; Path=/; Secure'; });
  await state.release('complete'); await navigated(page);
  expect((await page.context().cookies()).find(cookie => cookie.name === 'bubaly_vid')?.value).toBe('visitor-newer');
});
test('a newer recovery grant during provider verification prevents session installation', async ({ page }) => {
  const state = await fixture(page, { recovery: true, hold: 'user' }); await expect.poll(() => state.userReads).toBe(1);
  await page.evaluate(() => window.__callbackUi.seedGrant()); await state.release('user');
  await expect(page.getByRole('alert')).toContainText('Your sign-in state changed');
  expect(await page.evaluate(() => window.__callbackUi.user())).toBeNull();
  expect(await page.evaluate(key => sessionStorage.getItem(key), grantKey)).toBe('newer.grant');
});

for (const malformedRecovery of ['missing-grant', 'non-string-grant', 'invalid-grant', 'oversized-grant',
  'missing-identity', 'wrong-user', 'wrong-session', 'expired-identity', 'invalid-email'] as const) {
  test(`malformed recovery receipt ${malformedRecovery} is rejected before token adoption`, async ({ page }) => {
    const state = await fixture(page, { recovery: true, existing: 'B', malformedRecovery });
    await expect(page.getByRole('alert')).toContainText('This sign-in link is invalid');
    expect(state.calls.map(call => call.name)).toEqual(['complete']);
    expect(state.userReads).toBe(0);
    expect(await page.evaluate(() => window.__callbackUi.routes)).toEqual([]);
    expect(await page.evaluate(() => window.__callbackUi.user())).toBe(userB);
    expect(await page.evaluate(key => sessionStorage.getItem(key), grantKey)).toBeNull();
    expect((await page.context().cookies()).some(cookie => cookie.name === cookieKey + '-code-verifier')).toBe(true);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  });
}

for (const change of ['login', 'logout'] as const) {
  test(`held no-code fallback respects ${change} before deciding navigation`, async ({ page }) => {
    const state = await fixture(page, { noCode: true, existing: 'A', hold: 'user', next: '/dashboard/meals' });
    await expect.poll(() => state.userReads).toBe(1);
    if (change === 'login') await page.evaluate(() => window.__callbackUi.login('B'));
    else await page.evaluate(() => window.__callbackUi.logout());
    const before = (await page.context().cookies()).filter(cookie => cookie.name.startsWith(cookieKey));
    await state.release('user');
    await expect(page.getByRole('alert')).toContainText('Your sign-in state changed');
    expect(state.calls).toEqual([]);
    expect(await page.evaluate(() => window.__callbackUi.routes)).toEqual([]);
    expect((await page.context().cookies()).filter(cookie => cookie.name.startsWith(cookieKey))).toEqual(before);
    expect(await page.evaluate(() => window.__callbackUi.user())).toBe(change === 'login' ? userB : null);
  });
}

test('completion history cleanup keeps only the safe destination before any action response', async ({ page }) => {
  const state = await fixture(page, { hold: 'complete', next: '/dashboard/meals?week=next',
    extraQuery: { access_token: 'synthetic-access-secret', refresh_token: 'synthetic-refresh-secret',
      id_token: 'synthetic-id-secret', token_hash: 'synthetic-token-hash', arbitrary: 'untrusted-value' },
    hash: 'access_token=synthetic-fragment-secret' });
  await expect.poll(() => state.calls.length).toBe(1);
  const url = new URL(page.url());
  expect(url.pathname).toBe('/auth/complete');
  expect([...url.searchParams]).toEqual([['next', '/dashboard/meals?week=next']]);
  expect(url.hash).toBe('');
  expect(await page.evaluate(() => window.__callbackUi.routes)).toEqual([]);
  await page.evaluate(() => window.__callbackUi.retire());
  await state.release('complete');
});

for (const beforeMount of ['logout-retained', 'login'] as const) {
  test(`the original page request cannot complete after ${beforeMount} before mount`, async ({ page }) => {
    const state = await fixture(page, { beforeMount });
    await expect(page.getByRole('alert')).toContainText('Your sign-in state changed');
    expect(state.calls).toEqual([]); expect(state.userReads).toBe(0);
    expect(await page.evaluate(() => window.__callbackUi.routes)).toEqual([]);
    expect(await page.evaluate(() => window.__callbackUi.user())).toBe(beforeMount === 'login' ? userB : null);
  });
}

for (const admission of [null, '', 'invalid', 'a'.repeat(513)]) {
  test(`invalid request witness cannot use an existing login as fallback (${admission === null ? 'absent' : admission.length})`, async ({ page }) => {
    const state = await fixture(page, { admission, noCode: true, existing: 'B' });
    await expect(page.getByRole('alert')).toContainText('Your sign-in state changed');
    expect(state.calls).toEqual([]); expect(state.userReads).toBe(0);
    expect(await page.evaluate(() => window.__callbackUi.routes)).toEqual([]);
    expect(await page.evaluate(() => window.__callbackUi.user())).toBe(userB);
  });
}
for (const beforeMount of ['logout', 'login'] as const) {
  test(`no-code page response respects ${beforeMount} before mount`, async ({ page }) => {
    const state = await fixture(page, { noCode: true, existing: 'A', beforeMount });
    await expect(page.getByRole('alert')).toContainText('Your sign-in state changed');
    expect(state.calls).toEqual([]); expect(state.userReads).toBe(0);
    expect(await page.evaluate(() => window.__callbackUi.routes)).toEqual([]);
    expect(await page.evaluate(() => window.__callbackUi.user())).toBe(beforeMount === 'login' ? userB : null);
  });
}
test('same-session renewal between request and mount still completes', async ({ page }) => {
  const state = await fixture(page, { existing: 'A', beforeMount: 'rotate' }); await navigated(page);
  expect(state.calls.map(call => call.name)).toEqual(['complete']);
  expect(await page.evaluate(() => window.__callbackUi.user())).toBe(userA);
});
test('recovery page received after another login does not begin exchange or grant inspection', async ({ page }) => {
  const state = await fixture(page, { existing: 'A', recovery: true, beforeMount: 'login' });
  await expect(page.getByRole('alert')).toContainText('Your sign-in state changed');
  expect(state.calls).toEqual([]); expect(state.userReads).toBe(0);
  expect(await page.evaluate(() => window.__callbackUi.user())).toBe(userB);
  expect(await page.evaluate(key => sessionStorage.getItem(key), grantKey)).toBeNull();
});
