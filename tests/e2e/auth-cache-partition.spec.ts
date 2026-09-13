import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { CacheAccessIdentity } from '../../lib/offline/cache-scope';

// Real React, AppProvider, cache/session boundary, query hook, browser factory,
// installed SSR cookie adapter and auth/PostgREST SDK. Only HTTP responses are
// synthetic. Browser restart state remains in memory and contains no real user.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function sourceFile(filename: string) {
  return [filename, `${filename}.ts`, `${filename}.tsx`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? filename;
}
function collect(filename: string): string {
  const id = path.resolve(sourceFile(filename));
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  // Keep the real catalogue strings used by this boundary, without shipping
  // every unrelated product string into each browser fixture.
  const source = /\.json$/.test(id)
    ? `module.exports = { default: ${JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw)).filter(([key]) => key.startsWith('auth.cache'))))} };`
    : /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (name === 'react' || name === '@supabase/supabase-js') { item.imports[name] = name; continue; }
    let target: string;
    if (name.startsWith('@/')) target = path.resolve(name.slice(2));
    else if (name.startsWith('.') && /\.tsx?$/.test(id)) target = path.resolve(path.dirname(id), name);
    else target = require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries([
  'lib/supabase/client.ts', 'lib/auth/cache-session.ts', 'lib/auth/session-change.ts', 'lib/hooks/use-realtime-query.ts', 'lib/offline/cache.ts',
  'components/app/app-context.tsx', 'components/i18n/locale-provider.tsx', 'lib/i18n/locales.ts', 'lib/i18n/messages.ts',
].map(file => [file, collect(file)]));
const origin = 'https://auth-cache-partition-fixture.invalid';
const provider = 'https://partition-fixture.supabase.co';
const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sessionA = '11111111-1111-4111-8111-111111111111';
const sessionB = '22222222-2222-4222-8222-222222222222';
const accessA: CacheAccessIdentity = {
  userId: userA, familyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  memberId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', membershipUpdatedAt: '2026-09-12T12:00:00Z',
  role: 'parent', isSuperAdmin: false, planLevel: 2,
  featureTiers: { '/dashboard/calendar': 'free', '/dashboard/briefing': 'plus' },
};
type Row = { id: string };
type ProviderState = {
  user: string; session: string; rotation: number; rows: Row[]; unavailable: boolean;
  tokenVariant?: 'missing-session' | 'invalid-session' | 'wrong-sub' | 'missing-sub' | 'non-jwt';
  calls: string[];
};
type Snapshot = { user: string; role: string; data: Row[]; copied: Row[]; loading: boolean; error: string | null; stale: boolean; instance: number };
type Probe = {
  signIn: () => Promise<void>; signOut: () => Promise<void>; rotate: () => Promise<void>;
  mount: (access: CacheAccessIdentity, provider?: boolean) => void; unmount: () => void;
  snapshot: () => Snapshot | null; refresh: () => Promise<void>; settle: () => Promise<void>;
  disk: () => Record<string, string>; failRemoval: () => void; removals: number;
  holdBootstrap: () => void; releaseBootstrap: () => Promise<void>; bootstrapHeld: boolean;
  holdSdkInitial: () => void; releaseSdkInitial: () => Promise<void>; sdkInitialHeld: boolean;
  authEvents: Array<{ event: string; userId: string | null; sessionId: string | null }>;
  identity: () => { userId: string; sessionId: string } | null;
  observedUser: () => string | null; locale: string;
  failWarmRead: () => Promise<void>; reconcile: () => Promise<void>; errors: string[];
  seedLegacy: (access: CacheAccessIdentity) => void;
};
declare global { interface Window { __authPartition: Probe } }

async function install(context: BrowserContext, override: Partial<ProviderState> = {}): Promise<ProviderState> {
  const state: ProviderState = { user: userA, session: sessionA, rotation: 0, rows: [{ id: 'private-a' }], unavailable: false, calls: [], ...override };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }); return;
    }
    if (url.origin !== provider) throw new Error(`Unexpected fixture destination: ${url.origin}`);
    state.calls.push(`${request.method()} ${url.pathname}`);
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (request.method() === 'OPTIONS' || url.pathname === '/auth/v1/logout') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/rest/v1/family_members') {
      await route.fulfill({ status: state.unavailable ? 403 : 200, headers, contentType: 'application/json', body: JSON.stringify(state.unavailable
        ? { code: '42501', message: 'Fixture permission unavailable', details: null, hint: null } : state.rows) }); return;
    }
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const claims: Record<string, unknown> = { sub: state.user, session_id: state.session, exp: expires, aud: 'authenticated', rotation: state.rotation };
    if (state.tokenVariant === 'missing-session') delete claims.session_id;
    if (state.tokenVariant === 'invalid-session') claims.session_id = 'not-a-session-uuid';
    if (state.tokenVariant === 'wrong-sub') claims.sub = userB;
    if (state.tokenVariant === 'missing-sub') delete claims.sub;
    const jwt = state.tokenVariant === 'non-jwt' ? 'synthetic-malformed-token' : [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-signature',
    ].join('.');
    const user = { id: state.user, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' };
    if (url.pathname === '/auth/v1/token') {
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ access_token: jwt, refresh_token: `synthetic-refresh-${state.rotation}`, token_type: 'bearer', expires_in: 3600, expires_at: expires, user }) }); return;
    }
    if (url.pathname === '/auth/v1/user') { await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(user) }); return; }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  });
  return state;
}

async function load(page: Page) {
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, entries = ${JSON.stringify(entries)}, loaded = {};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-fixture' } };
    function load(id) {
      if (id === 'react') return React;
      if (id === '@supabase/supabase-js') return window.supabase;
      if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module: ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process);
      return module.exports;
    }
    const db = load(entries['lib/supabase/client.ts']).createClient();
    const p = window.__authPartition = { errors: [], removals: 0, bootstrapHeld: false, sdkInitialHeld: false, authEvents: [], locale: 'en-US' };
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    window.addEventListener('error', event => { p.errors.push(event.message); });
    const originalGetSession = db.auth.getSession.bind(db.auth);
    p.signIn = async () => { const { error } = await db.auth.signInWithPassword({ email: 'fixture@example.invalid', password: 'synthetic-password' }); if (error) throw error; };
    p.signOut = async () => { const { error } = await db.auth.signOut({ scope: 'local' }); if (error) throw error; };
    p.rotate = async () => { const { error } = await db.auth.refreshSession(); if (error) throw error; };
    let release;
    p.holdBootstrap = () => {
      db.auth.getSession = async () => {
        db.auth.getSession = originalGetSession;
        const result = await originalGetSession();
        p.bootstrapHeld = true;
        return new Promise(resolve => { release = () => resolve(result); });
      };
    };
    p.releaseBootstrap = async () => { release(); await p.settle(); };
    let releaseInitial;
    p.holdSdkInitial = () => {
      // The installed SDK starts its subscription's INITIAL_SESSION by reading
      // storage asynchronously. Hold that one captured cookie value, allowing
      // the store's separate getSession and newer real SDK events to complete.
      const storage = db.auth.storage, originalGet = storage.getItem;
      storage.getItem = function(key) {
        const value = originalGet.call(this, key);
        if (key !== db.auth.storageKey) return value;
        storage.getItem = originalGet;
        return Promise.resolve(value).then(raw => {
          p.sdkInitialHeld = true;
          return new Promise(resolve => { releaseInitial = () => resolve(raw); });
        });
      };
      const subscribe = db.auth.onAuthStateChange.bind(db.auth);
      db.auth.onAuthStateChange = callback => subscribe((event, session) => {
        let sessionId = null;
        try { sessionId = JSON.parse(atob(session.access_token.split('.')[1])).session_id ?? null; } catch {}
        p.authEvents.push({ event, userId: session?.user.id ?? null, sessionId });
        return callback(event, session);
      });
    };
    p.releaseSdkInitial = async () => { releaseInitial(); await p.settle(); };
    p.identity = () => load(entries['lib/auth/cache-session.ts']).getCacheSessionSnapshot().identity;
    p.observedUser = () => load(entries['lib/auth/cache-session.ts']).getCacheSessionSnapshot().observedUserId;
    p.failWarmRead = async () => {
      db.auth.getSession = async () => ({ data: { session: null }, error: new window.supabase.AuthRetryableFetchError('Fixture warm refresh unavailable', 503) });
      try { await p.reconcile(); } finally { db.auth.getSession = originalGetSession; }
    };
    p.reconcile = () => load(entries['lib/auth/cache-session.ts']).refreshCacheSession();
    const { AppProvider, useApp } = load(entries['components/app/app-context.tsx']);
    const { LocaleProvider } = load(entries['components/i18n/locale-provider.tsx']);
    const { localeOrDefault } = load(entries['lib/i18n/locales.ts']);
    const { getMessages } = load(entries['lib/i18n/messages.ts']);
    const { useRealtimeQuery } = load(entries['lib/hooks/use-realtime-query.ts']);
    let serial = 0;
    function Query({ access }) {
      const [instance] = React.useState(() => ++serial);
      const [copied, setCopied] = React.useState([]);
      const [draft, setDraft] = React.useState('');
      const state = useRealtimeQuery({ table: 'family_members', familyId: access.familyId, deps: [access.familyId],
        fetcher: client => client.from('family_members').select('*').eq('family_id', access.familyId) });
      p.refresh = state.refresh;
      const snapshot = { user: access.userId, role: access.role, data: state.data, copied, loading: state.loading, error: state.error, stale: state.stale, instance };
      return React.createElement('section', null,
        React.createElement('pre', null, JSON.stringify(snapshot)),
        React.createElement('input', { 'aria-label': 'Private draft', value: draft, onChange: event => setDraft(event.target.value) }),
        React.createElement('button', { onClick: () => setCopied(state.data) }, 'Copy rows locally'));
    }
    function AppQuery() { return React.createElement(Query, { access: useApp() }); }
    let root;
    p.mount = (access, provider = true) => {
      if (!root) root = ReactDOM.createRoot(document.getElementById('root'));
      const value = { userId: access.userId, userEmail: 'fixture@example.invalid', familyId: access.familyId,
        family: { id: access.familyId, name: 'Fixture family' }, role: access.role, families: [],
        isSuperAdmin: access.isSuperAdmin, defaultDashboard: 'family', planLevel: access.planLevel, featureTiers: access.featureTiers };
      const child = provider
        ? React.createElement(AppProvider, { value, membershipId: access.memberId, membershipUpdatedAt: access.membershipUpdatedAt, initialMembers: [] }, React.createElement(AppQuery))
        : React.createElement(Query, { access });
      const locale = localeOrDefault(p.locale);
      ReactDOM.flushSync(() => root.render(React.createElement(LocaleProvider, {
        locale, source: 'default', messages: getMessages(locale.code),
      }, child)));
    };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.snapshot = () => { const pre = document.querySelector('pre'); return pre ? JSON.parse(pre.textContent) : null; };
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    p.disk = () => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('bub:cache:')).map(key => [key, localStorage.getItem(key)]));
    p.seedLegacy = access => { const cache = load(entries['lib/offline/cache.ts']); cache.writeCache(cache.cacheKey('family_members', access.familyId, [access.familyId]), [{ id: 'private-a' }]); };
    p.failRemoval = () => { const original = Storage.prototype.removeItem; Storage.prototype.removeItem = function(key) { if (key.startsWith('bub:cache:')) { p.removals += 1; throw new Error('Fixture cache deletion denied'); } return original.call(this, key); }; };
  })();` });
}

async function mount(page: Page, access = accessA, provider = true) {
  await page.evaluate(({ access, provider }) => window.__authPartition.mount(access, provider), { access, provider });
  await page.evaluate(() => window.__authPartition.settle());
}
async function snapshot(page: Page) { return page.evaluate(() => window.__authPartition.snapshot()); }
async function privateRows(page: Page) {
  await expect.poll(() => snapshot(page)).toMatchObject({ data: [{ id: 'private-a' }], error: null, loading: false });
}
async function noRows(page: Page) {
  await expect.poll(() => snapshot(page)).toMatchObject({ data: [], loading: false, error: expect.any(String) });
  await expect(page.locator('main')).not.toContainText('private-a');
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.afterEach(async ({ page }) => {
  if (await page.evaluate(() => !!window.__authPartition).catch(() => false)) expect(await page.evaluate(() => window.__authPartition.errors)).toEqual([]);
});

test('same authenticated session restores its offline rows after a browser restart (positive control)', async ({ browser }) => {
  const first = await browser.newContext();
  let restored: BrowserContext | undefined;
  try {
    await install(first); const page = await first.newPage(); await load(page);
    await page.evaluate(() => window.__authPartition.signIn()); await mount(page); await privateRows(page);
    const saved = await first.storageState();
    expect(saved.origins[0].localStorage.some(entry => entry.value.includes('private-a'))).toBe(true);
    await first.close();
    restored = await browser.newContext({ storageState: saved }); await install(restored, { unavailable: true });
    const next = await restored.newPage(); await load(next); await mount(next);
    await expect.poll(() => snapshot(next)).toMatchObject({ data: [{ id: 'private-a' }], stale: true, error: expect.any(String) });
  } finally { await first.close(); await restored?.close(); }
});

for (const changeUser of [true, false]) {
  test(`${changeUser ? 'different user in same family' : 'same user with a new sign-in session'} cannot recover undeletable old rows after browser restart`, async ({ browser }) => {
    const first = await browser.newContext(); let restored: BrowserContext | undefined;
    try {
      const state = await install(first); const page = await first.newPage(); await load(page);
      await page.evaluate(() => window.__authPartition.signIn()); await mount(page); await privateRows(page);
      await page.getByLabel('Private draft').fill('private draft A'); await page.getByRole('button', { name: 'Copy rows locally' }).click();
      await page.evaluate(() => window.__authPartition.failRemoval());
      await page.evaluate(() => window.__authPartition.signOut());
      await expect(page.locator('main')).not.toContainText('private-a');
      expect(await page.getByLabel('Private draft').count()).toBe(0);
      state.user = changeUser ? userB : userA; state.session = sessionB; state.unavailable = true;
      await page.evaluate(() => window.__authPartition.signIn());
      const access = { ...accessA, userId: state.user, memberId: changeUser ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' : accessA.memberId };
      await mount(page, access); await noRows(page);
      expect(await page.evaluate(() => window.__authPartition.removals)).toBeGreaterThan(0);
      expect(Object.values(await page.evaluate(() => window.__authPartition.disk())).some(value => value.includes('private-a'))).toBe(true);
      const saved = await first.storageState(); await first.close();
      restored = await browser.newContext({ storageState: saved }); await install(restored, { user: state.user, session: sessionB, unavailable: true });
      const next = await restored.newPage(); await load(next); await mount(next, access); await noRows(next);
      expect(Object.values(await next.evaluate(() => window.__authPartition.disk())).some(value => value.includes('private-a'))).toBe(true);
    } finally { await first.close(); await restored?.close(); }
  });
}

test('token rotation with unchanged session_id preserves cache, copied rows and an active form', async ({ page, context }) => {
  const state = await install(context); await load(page); await page.evaluate(() => window.__authPartition.signIn());
  await mount(page); await privateRows(page); await page.getByLabel('Private draft').fill('unsaved family note');
  await page.getByRole('button', { name: 'Copy rows locally' }).click();
  const before = await snapshot(page), disk = await page.evaluate(() => window.__authPartition.disk());
  state.rotation += 1; await page.evaluate(() => window.__authPartition.rotate());
  await mount(page, { ...accessA, featureTiers: { '/dashboard/briefing': 'plus', '/dashboard/calendar': 'free' } });
  expect(await snapshot(page)).toMatchObject({ instance: before!.instance, copied: [{ id: 'private-a' }], data: [{ id: 'private-a' }] });
  await expect(page.getByLabel('Private draft')).toHaveValue('unsaved family note');
  expect(await page.evaluate(() => window.__authPartition.disk())).toEqual(disk);
  expect(Object.values(disk).join('')).not.toContain('synthetic-signature');
});

const accessChanges: Array<[string, Partial<CacheAccessIdentity>]> = [
  ['membership row', { memberId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }],
  ['membership revision', { membershipUpdatedAt: '2026-09-12T13:00:00Z' }],
  ['role', { role: 'guest' }], ['super administrator', { isSuperAdmin: true }],
  ['plan', { planLevel: 0 }], ['feature permissions', { featureTiers: { '/dashboard/briefing': 'off' } }],
];
for (const [name, change] of accessChanges) {
  test(`observed ${name} change retires copied component state and prior disk partition`, async ({ page, context }) => {
    const state = await install(context); await load(page); await page.evaluate(() => window.__authPartition.signIn());
    await mount(page); await privateRows(page); await page.getByLabel('Private draft').fill('private unsaved note');
    await page.getByRole('button', { name: 'Copy rows locally' }).click();
    const previous = await snapshot(page); state.unavailable = true;
    await mount(page, { ...accessA, ...change }); await noRows(page);
    expect(await snapshot(page)).toMatchObject({ copied: [] });
    expect((await snapshot(page))!.instance).not.toBe(previous!.instance);
    await expect(page.getByLabel('Private draft')).toHaveValue('');
  });
}

test('a delayed bootstrap result cannot replace a newer actual SDK sign-in event', async ({ page, context }) => {
  const state = await install(context); await load(page); await page.evaluate(() => window.__authPartition.signIn());
  await page.evaluate(() => window.__authPartition.holdBootstrap()); await mount(page);
  await expect.poll(() => page.evaluate(() => window.__authPartition.bootstrapHeld)).toBe(true);
  state.user = userB; state.session = sessionB; state.unavailable = true;
  await page.evaluate(() => window.__authPartition.signIn());
  await mount(page, { ...accessA, userId: userB, memberId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
  await page.evaluate(() => window.__authPartition.releaseBootstrap()); await noRows(page);
  expect((await snapshot(page))!.user).toBe(userB);
});

for (const changeUser of [true, false]) {
  test(`delayed SDK INITIAL_SESSION cannot replace ${changeUser ? 'a newer user' : 'a newer session for the same user'} or restore retired UI`, async ({ page, context }) => {
    const state = await install(context); await load(page); await page.evaluate(() => window.__authPartition.signIn());
    await page.evaluate(() => window.__authPartition.holdSdkInitial()); await mount(page); await privateRows(page);
    expect(await page.evaluate(() => window.__authPartition.sdkInitialHeld)).toBe(true);
    expect(await page.evaluate(() => window.__authPartition.authEvents)).toEqual([]);
    await page.getByLabel('Private draft').fill('old session private draft');
    await page.getByRole('button', { name: 'Copy rows locally' }).click();
    const before = await snapshot(page);
    await page.evaluate(() => window.__authPartition.failRemoval());
    state.user = changeUser ? userB : userA; state.session = sessionB; state.unavailable = true;
    await page.evaluate(() => window.__authPartition.signIn());
    const current = { userId: state.user, sessionId: sessionB };
    expect(await page.evaluate(() => window.__authPartition.identity())).toEqual(current);
    if (changeUser) {
      await expect(page.getByLabel('Private draft')).toHaveCount(0);
      expect(await snapshot(page)).toBeNull();
    } else {
      await noRows(page);
      expect((await snapshot(page))!.instance).not.toBe(before!.instance);
      await expect(page.getByLabel('Private draft')).toHaveValue('');
      await page.getByLabel('Private draft').fill('new session private draft');
    }
    const afterSignIn = await snapshot(page);
    await page.evaluate(() => window.__authPartition.releaseSdkInitial());
    expect(await page.evaluate(() => window.__authPartition.authEvents)).toEqual([
      { event: 'SIGNED_IN', userId: state.user, sessionId: sessionB },
      { event: 'INITIAL_SESSION', userId: userA, sessionId: sessionA },
    ]);
    expect(await page.evaluate(() => window.__authPartition.identity())).toEqual(current);
    expect(await snapshot(page)).toEqual(afterSignIn);
    if (changeUser) {
      await expect(page.getByLabel('Private draft')).toHaveCount(0);
      await mount(page, { ...accessA, userId: userB, memberId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
      await noRows(page); await expect(page.getByLabel('Private draft')).toHaveValue('');
    } else await expect(page.getByLabel('Private draft')).toHaveValue('new session private draft');
    expect(Object.values(await page.evaluate(() => window.__authPartition.disk())).some(value => value.includes('private-a'))).toBe(true);
  });
}

test('an initial agreeing session bootstrap preserves text entered while both SDK reads are delayed', async ({ page, context }) => {
  await install(context); await load(page); await page.evaluate(() => window.__authPartition.signIn());
  await page.evaluate(() => { const p = window.__authPartition; p.holdSdkInitial(); p.holdBootstrap(); });
  await mount(page);
  expect(await page.evaluate(() => window.__authPartition.sdkInitialHeld && window.__authPartition.bootstrapHeld)).toBe(true);
  expect(await page.evaluate(() => window.__authPartition.identity())).toBeNull();
  expect(await snapshot(page)).toMatchObject({ data: [], loading: true });
  const before = await snapshot(page);
  await page.getByLabel('Private draft').fill('entered during session restore');
  await page.evaluate(() => window.__authPartition.releaseBootstrap()); await privateRows(page);
  expect((await snapshot(page))!.instance).toBe(before!.instance);
  await expect(page.getByLabel('Private draft')).toHaveValue('entered during session restore');
  await page.evaluate(() => window.__authPartition.releaseSdkInitial());
  expect((await snapshot(page))!.instance).toBe(before!.instance);
  await expect(page.getByLabel('Private draft')).toHaveValue('entered during session restore');
});

test('transient warm session read failure preserves confirmed session, cached rows and draft state', async ({ page, context }) => {
  await install(context); await load(page); await page.evaluate(() => window.__authPartition.signIn());
  await mount(page); await privateRows(page); await page.getByLabel('Private draft').fill('keep through outage');
  const before = await snapshot(page), disk = await page.evaluate(() => window.__authPartition.disk());
  await page.evaluate(() => window.__authPartition.failWarmRead());
  await mount(page);
  expect(await snapshot(page)).toEqual(before);
  await expect(page.getByLabel('Private draft')).toHaveValue('keep through outage');
  expect(await page.evaluate(() => window.__authPartition.disk())).toEqual(disk);
});

test('a failed read after malformed-token sign-in keeps the old account blocked with the real French locale provider', async ({ page, context }) => {
  const french = JSON.parse(fs.readFileSync('lib/i18n/messages/fr-FR.json', 'utf8')) as Record<string, string>;
  const changed = french['auth.cacheSessionChanged'];
  expect(changed).toMatch(/^Votre session/);
  const state = await install(context); await load(page); await page.evaluate(() => window.__authPartition.signIn());
  await page.evaluate(() => { window.__authPartition.locale = 'fr-FR'; });
  await mount(page); await privateRows(page);
  await page.getByLabel('Private draft').fill('old account private draft');
  await page.getByRole('button', { name: 'Copy rows locally' }).click();
  state.user = userB; state.session = sessionB; state.tokenVariant = 'missing-session'; state.unavailable = true;
  await page.evaluate(() => window.__authPartition.signIn());
  expect(await page.evaluate(() => window.__authPartition.identity())).toBeNull();
  expect(await page.evaluate(() => window.__authPartition.observedUser())).toBe(userB);
  await expect(page.getByRole('status')).toHaveText(changed);
  await expect(page.getByLabel('Private draft')).toHaveCount(0);
  expect(await snapshot(page)).toBeNull();
  const readCount = state.calls.filter(call => call.includes('/rest/')).length;
  await page.evaluate(() => window.__authPartition.failWarmRead()); await mount(page);
  expect(await page.evaluate(() => window.__authPartition.observedUser())).toBe(userB);
  expect(await snapshot(page)).toBeNull();
  await expect(page.getByRole('status')).toHaveText(changed);
  await expect(page.getByLabel('Private draft')).toHaveCount(0);
  expect(state.calls.filter(call => call.includes('/rest/')).length).toBe(readCount);
});

for (const tokenVariant of ['missing-session', 'invalid-session', 'wrong-sub', 'missing-sub', 'non-jwt'] as const) {
  test(`a session with ${tokenVariant} never hydrates its previously owned disk rows after restart`, async ({ browser }) => {
    const first = await browser.newContext(); let restored: BrowserContext | undefined;
    try {
      const state = await install(first); const page = await first.newPage(); await load(page);
      await page.evaluate(() => window.__authPartition.signIn()); await mount(page); await privateRows(page);
      await page.evaluate(access => window.__authPartition.seedLegacy(access), accessA);
      await page.evaluate(() => window.__authPartition.failRemoval());
      state.tokenVariant = tokenVariant; state.unavailable = true; state.rotation += 1;
      await page.evaluate(() => window.__authPartition.rotate());
      const before = await page.evaluate(() => window.__authPartition.disk());
      expect(Object.values(before).some(value => value.includes('private-a'))).toBe(true);
      const saved = await first.storageState(); await first.close();
      restored = await browser.newContext({ storageState: saved }); await install(restored, { tokenVariant, unavailable: true });
      const next = await restored.newPage(); await load(next); await mount(next);
      await expect(next.locator('main')).not.toContainText('private-a');
      expect(await next.evaluate(() => window.__authPartition.disk())).toEqual(before);
      expect((await snapshot(next))?.data ?? []).toEqual([]);
      expect(await next.evaluate(() => window.__authPartition.errors)).toEqual([]);
    } finally { await first.close(); await restored?.close(); }
  });
}

test('valid authentication never adopts unowned v1 rows, and queries outside the provider never read or write disk', async ({ page, context }) => {
  const state = await install(context, { unavailable: true }); await load(page); await page.evaluate(() => window.__authPartition.signIn());
  await page.evaluate(access => window.__authPartition.seedLegacy(access), accessA);
  await mount(page); await noRows(page);
  state.unavailable = false; await page.evaluate(() => window.__authPartition.refresh()); await privateRows(page);
  const disk = await page.evaluate(() => window.__authPartition.disk());
  await page.evaluate(() => window.__authPartition.unmount()); state.unavailable = true;
  await mount(page, accessA, false); await noRows(page);
  state.unavailable = false; state.rows = [{ id: 'network-only' }];
  await page.evaluate(() => window.__authPartition.refresh());
  await expect.poll(() => snapshot(page)).toMatchObject({ data: [{ id: 'network-only' }], error: null });
  expect(await page.evaluate(() => window.__authPartition.disk())).toEqual(disk);
});
