import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Installed SDK/SSR adapter, real React, actual cookies, and two browser tabs.
// The only server is an intercepted synthetic auth provider; no preview runs.
const { react, reactDom } = reactBrowserScripts('development');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve(filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (['react', 'next/navigation', '@/lib/native/capacitor', '@capacitor/app'].includes(name)) { item.imports[name] = name; continue; }
    if (name === '@supabase/supabase-js') { item.imports[name] = 'sdk'; continue; }
    let target: string;
    if (name.startsWith('@/') || (name.startsWith('.') && /\.tsx?$/.test(id))) {
      const base = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(id), name);
      target = ['.ts', '.tsx', '.js', ''].map(extension => base + extension).find(candidate => fs.existsSync(candidate))!;
    } else target = require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries([
  'lib/supabase/client.ts', 'lib/auth/cache-session.ts', 'lib/auth/session-change.ts',
  'lib/offline/cache.ts', 'components/auth/session-keeper.tsx',
  'lib/auth/browser-session-storage.ts', 'lib/offline/cache-scope.tsx', 'lib/hooks/use-realtime-query.ts',
].map(file => [file, collect(file)]));
const origin = 'https://session-reconcile-fixture.invalid';
const provider = 'https://reconcile-fixture.supabase.co';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type Transport = 'both' | 'storage-only' | 'broadcast-only';
type Probe = {
  signIn: (user: 'a' | 'b') => Promise<void>; mount: (user: 'a' | 'b') => void;
  clearCookies: () => void; notify: () => void;
  snapshot: () => { status: string; identity: { userId: string } | null };
  revision: () => number; generation: () => number;
  realtimeToken: () => string | null;
  holdNextEmptyRead: () => void; releaseRead: () => Promise<void>; readHeld: boolean;
  pauseEmptyRemoval: () => void; releaseRemoval: () => void; removalHeld: boolean;
  sdkSignOut: () => Promise<void>;
  holdNextSessionRead: () => void; releaseSessionRead: () => void; sessionReadHeld: boolean;
  setReadFailure: (fail: boolean) => void; reconcile: () => Promise<void>;
  holdNextPositiveReceipt: () => void; releasePositiveReceipt: () => void; positiveReceiptHeld: boolean;
  realtimeMatchesCookie: () => boolean;
  mountRows: (user: 'a' | 'b') => void; visibleRows: () => string[];
  holdNextSdkGetSession: () => void; releaseSdkGetSession: () => void; sdkGetSessionHeld: boolean;
  refreshes: number; events: string[]; errors: string[];
  documentId: string; serverAccess: { userId: string; familyId: string; role: string }; mountServer: () => void;
};
declare global { interface Window { __sessionReload: Probe } }

type ServerFixture = {
  protected: boolean; family: string; role: 'parent' | 'child'; failure: 'none' | 'auth' | 'membership' | 'missing-family';
  requests: Array<{ path: string; user: string | null; family: string | null }>;
  grants: number; documents: number; chunked: boolean;
  afterContext?: () => Promise<void>;
};
const F1 = '11111111-3333-4333-8333-111111111111';
const F2 = '22222222-3333-4333-8333-222222222222';
const F3 = '33333333-3333-4333-8333-333333333333';
function verifiedUser(authorization: string | null): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3 || parts[2] !== 'synthetic-signature') return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return [A, B].includes(value.sub) && value.exp > Date.now() / 1000 ? value.sub : null;
  } catch { return null; }
}
// Request cookies and network responses are synthetic. The actual server
// factory, SDK getUser(), membership resolver and redirect guard are imported.
// This is not Next rendering, hosted Auth/RLS or server-writer retirement proof.
async function requestContext(cookieHeader: string, state: ServerFixture) {
  const { parseCookieHeader } = require('@supabase/ssr');
  const cookies = parseCookieHeader(cookieHeader);
  const writes: unknown[] = [];
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href);
    if (url.origin !== provider || (init?.method ?? 'GET').toUpperCase() !== 'GET') throw new Error('Unexpected server fixture transport');
    const user = verifiedUser(new Headers(init?.headers).get('authorization'));
    state.requests.push({ path: url.pathname, user, family: url.searchParams.get('family_id') });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (!user) return json({ message: 'Invalid synthetic token', code: 'bad_jwt' }, 401);
    if (url.pathname === '/auth/v1/user') {
      if (state.failure === 'auth') return json({ message: 'Synthetic auth unavailable' }, 503);
      return json({ id: user, aud: 'authenticated', role: 'authenticated', email: user === A ? 'a@example.invalid' : 'b@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' });
    }
    const family = user === B ? F2 : state.family;
    if (url.pathname === '/rest/v1/family_members') {
      if (url.searchParams.get('select') !== '*' || url.searchParams.get('user_id') !== 'eq.' + user || url.searchParams.get('is_active') !== 'eq.true') throw new Error('Server membership query lost identity/activity');
      if (state.failure === 'membership') return json({ message: 'Synthetic membership unavailable' }, 503);
      return json([{ id: user === A ? '44444444-4444-4444-8444-444444444444' : '55555555-5555-4555-8555-555555555555', user_id: user, family_id: family, role: state.role, is_active: true, created_at: '2026-09-12T00:00:00Z', updated_at: '2026-10-11T14:00:00Z' }]);
    }
    if (url.pathname === '/rest/v1/families') {
      if (url.searchParams.get('select') !== '*' || url.searchParams.get('id') !== `in.(${family})`) throw new Error('Server family query lost current membership');
      return json(state.failure === 'missing-family' ? [] : [{ id: family, name: 'Synthetic current family' }]);
    }
    if (url.pathname === '/rest/v1/user_preferences') {
      if (url.searchParams.get('user_id') !== 'eq.' + user || url.searchParams.get('select') !== 'active_family_id') throw new Error('Server preference query lost current user');
      return json({ active_family_id: family });
    }
    throw new Error('Unexpected server fixture request: ' + url.pathname);
  };
  const loaded = new Map<string, { exports: any }>();
  const requestCookies = { getAll: () => cookies, set: (...args: unknown[]) => { writes.push(args); } };
  const unused = () => { throw new Error('Unexpected provisioning/feature fixture branch'); };
  const mocks: Record<string, unknown> = {
    'server-only': {},
    'next/headers': { cookies: async () => requestCookies },
    'next/navigation': { redirect: (url: string) => { throw new Error('Fixture redirect: ' + url); }, notFound: unused },
    '@/lib/server/plan': { resolveFamilyPlanLevel: unused },
    '@/lib/server/feature-entitlement': { resolveFeatureEntitlement: unused },
    '@/lib/server/ensure-family': { ensureActiveFamily: unused },
  };
  const syntheticProcess = { env: { NEXT_PUBLIC_SUPABASE_URL: provider, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon', NEXT_PUBLIC_SITE_URL: origin } };
  function loadServer(filename: string): any {
    const absolute = path.resolve(filename);
    if (loaded.has(absolute)) return loaded.get(absolute)!.exports;
    if (absolute.endsWith('.json')) return JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const entryModule = { exports: {} }; loaded.set(absolute, entryModule);
    const importModule = (name: string) => {
      if (name in mocks) return mocks[name];
      if (!name.startsWith('@/') && !name.startsWith('.')) return require(name);
      const base = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(absolute), name);
      const target = ['.ts', '.tsx', '.json', '.js', ''].map(extension => base + extension).find(candidate => fs.existsSync(candidate));
      if (!target) throw new Error('Unexpected server source import: ' + name);
      return loadServer(target);
    };
    new Function('require', 'module', 'exports', 'process', 'fetch', source)(importModule, entryModule, entryModule.exports, syntheticProcess, fetchFixture);
    return entryModule.exports;
  }
  const ctx = await loadServer('lib/supabase/auth.ts').requireUserContext();
  expect(writes).toEqual([]);
  return { userId: ctx.user.id, familyId: ctx.active.familyId, memberId: ctx.active.member.id, membershipUpdatedAt: ctx.active.member.updated_at, role: ctx.active.role, isSuperAdmin: false, planLevel: 1, featureTiers: {} };
}


async function install(context: BrowserContext, state: ServerFixture) {
  let tokenSequence = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      state.documents += 1;
      if (state.protected) {
        try {
          const headers = await route.request().allHeaders();
          const access = await requestContext(headers.cookie ?? '', state);
          if (state.afterContext) await state.afterContext();
          const content = JSON.stringify(access).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
          await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="synthetic-server-access" content="' + content + '"></head><body><main id="root"></main><main id="rows"></main></body></html>' });
        } catch (error) {
          if (!String(error).includes('Account context is temporarily unavailable') && !String(error).includes('Fixture redirect:')) throw error;
          await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><p data-testid="server-refused">Synthetic protected context unavailable</p></body></html>' });
        }
      } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main><main id="rows"></main></body></html>' }); return;
    }
    if (url.origin !== provider) throw new Error(`Unexpected fixture destination: ${url.origin}`);
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/logout' && url.searchParams.get('scope') === 'local') { await route.fulfill({status:204,headers}); return; }
    if (url.pathname === '/rest/v1/synthetic_private_rows') {
      const user = verifiedUser(route.request().headers().authorization ?? null);
      const family = user === B ? F2 : state.family;
      if (!user || url.searchParams.get('select') !== '*' || url.searchParams.get('family_id') !== 'eq.' + family) throw new Error('Private row query not current-user/current-family scoped');
      state.requests.push({ path: url.pathname, user, family });
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify([{ id: 'current-' + family + '-' + state.role, label: 'Synthetic freshly authorized row' }]) }); return;
    }
    if (url.pathname !== '/auth/v1/token' || !['password','refresh_token'].includes(url.searchParams.get('grant_type')!)) throw new Error(`Unexpected fixture request: ${url.pathname}`);
    state.grants += 1;
    const body = route.request().postDataJSON();
    const userId = body.email === 'b@example.invalid' || body.refresh_token === 'synthetic-refresh-'+B ? B : A;
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const claims = { sub: userId, session_id: userId === A ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', exp: expires, aud: 'authenticated', fixture_version: ++tokenSequence };
    const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-signature'].join('.');
    await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({
      access_token: token, refresh_token: `synthetic-refresh-${userId}`, token_type: 'bearer', expires_in: 3600, expires_at: expires,
      user: { id: userId, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: state.chunked ? { syntheticPad: 'x'.repeat(6500) } : {}, created_at: '2026-09-12T00:00:00Z' },
    }) });
  });
}

async function load(page: Page, transport: Transport = 'both', navigate = true) {
  if (navigate) await page.goto(origin);
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: sdk });
  await page.addScriptTag({ content: `(() => {
    if (${JSON.stringify(transport)} === 'storage-only') window.BroadcastChannel = undefined;
    if (${JSON.stringify(transport)} === 'broadcast-only') Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Fixture storage denied'); } });
    const sources = ${JSON.stringify(modules)}, entries = ${JSON.stringify(entries)}, loaded = {};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon' } };
    const p = window.__sessionReload = { refreshes: 0, events: [], errors: [], readHeld: false, removalHeld: false, sessionReadHeld: false, sdkGetSessionHeld: false };
    window.addEventListener('unhandledrejection', event => p.errors.push(String(event.reason)));
    const mocks = { react: React, sdk: window.supabase, 'next/navigation': { useRouter: () => router }, '@/lib/native/capacitor': { isNative: () => false }, '@/components/i18n/locale-provider': { useTranslations: () => key => key } };
    p.documentId = crypto.randomUUID();
    const serverAccess = JSON.parse(document.querySelector('meta[name="synthetic-server-access"]')?.content ?? 'null');
    p.serverAccess = serverAccess;
    const router = { refresh: () => { p.refreshes += 1; } };
    function load(id) {
      if (id in mocks) return mocks[id];
      if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module: ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process);
      return module.exports;
    }
    const storage = load(entries['lib/auth/browser-session-storage.ts']);
    const makeStorage = storage.createBrowserSessionStorage;
    let emptyReads = 0, releaseRemoval, holdSessionRead = false, releaseSessionRead, readFailure = false;
    storage.createBrowserSessionStorage = url => {
      const adapter = makeStorage(url), read = adapter.cookies.getAll;
      adapter.cookies.getAll = async () => {
        if (readFailure) throw new Error('Synthetic temporary cookie read failure');
        const cookies = read();
        if (holdSessionRead) {
          holdSessionRead = false;
          if (!cookies.some(cookie => /^sb-reconcile-fixture-auth-token(?:\\.\\d+)?$/.test(cookie.name))) throw new Error('Expected a saved session for visibility recovery');
          p.sessionReadHeld = true;
          await new Promise(resolve => { releaseSessionRead = resolve; });
        }
        if (emptyReads > 0 && --emptyReads === 0) {
          if (cookies.some(cookie => /^sb-reconcile-fixture-auth-token(?:\\.\\d+)?$/.test(cookie.name))) throw new Error('Expected empty removal lookup');
          p.removalHeld = true;
          await new Promise(resolve => { releaseRemoval = resolve; });
        }
        return cookies;
      };
      return adapter;
    };
    const client = load(entries['lib/supabase/client.ts']).createClient();
    const store = load(entries['lib/auth/cache-session.ts']);
    const changes = load(entries['lib/auth/session-change.ts']);
    const cache = load(entries['lib/offline/cache.ts']);
    const Boundary = load(entries['lib/offline/cache-scope.tsx']).AuthenticatedCacheBoundary;
    const useRealtimeQuery = load(entries['lib/hooks/use-realtime-query.ts']).useRealtimeQuery;
    const Keeper = load(entries['components/auth/session-keeper.tsx']).SessionKeeper;
    client.auth.onAuthStateChange(event => p.events.push(event));
    p.signIn = async user => {
      const { error } = await client.auth.signInWithPassword({ email: user + '@example.invalid', password: 'synthetic-password' });
      if (error) throw error;
    };
    let root;
    p.mount = user => {
      root ??= ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(Keeper, { userId: user === 'a' ? ${JSON.stringify(A)} : ${JSON.stringify(B)} })));
    };
    const privateRows = [{ id: 'family-a-private-row', label: 'Synthetic family A private data' }];
    function FamilyRows() {
      const result = useRealtimeQuery({ table: 'synthetic_private_rows', familyId: serverAccess?.familyId ?? 'family-a', fetcher: async () => serverAccess ? await client.from('synthetic_private_rows').select('*').eq('family_id', serverAccess.familyId) : ({ data: privateRows, error: null }) });
      return React.createElement('ul', { 'data-testid': 'family-rows' }, ...result.data.map(row => React.createElement('li', { key: row.id, 'data-row-id': row.id }, row.label)));
    }
    let rowsRoot;
    p.mountRows = user => {
      rowsRoot ??= ReactDOM.createRoot(document.getElementById('rows'));
      const access = serverAccess ?? { userId: user === 'a' ? ${JSON.stringify(A)} : ${JSON.stringify(B)}, familyId: user === 'a' ? 'family-a' : 'family-b', memberId: 'synthetic-member', membershipUpdatedAt: '2026-10-03T00:00:00.000Z', role: 'parent', isSuperAdmin: false, planLevel: 1, featureTiers: {} };
      ReactDOM.flushSync(() => rowsRoot.render(React.createElement(Boundary, { access }, React.createElement(FamilyRows))));
    };
    p.mountServer = () => {
      if (!serverAccess) throw new Error('Expected current server authorization');
      const user = serverAccess.userId === ${JSON.stringify(A)} ? 'a' : 'b';
      p.mount(user); p.mountRows(user);
    };
    p.visibleRows = () => Array.from(document.querySelectorAll('[data-testid="family-rows"] [data-row-id]'), row => row.getAttribute('data-row-id'));
    p.clearCookies = () => {
      for (const item of document.cookie.split(';')) {
        const name = item.trim().split('=')[0];
        if (/^sb-reconcile-fixture-auth-token(?:\\.\\d+)?$/.test(name)) document.cookie = name + '=; Max-Age=0; Path=/; Secure; SameSite=Lax';
      }
    };
    p.notify = changes.notifySessionStorageChanged;
    p.snapshot = store.getCacheSessionSnapshot;
    p.revision = changes.getSessionStorageChangeRevision;
    p.generation = cache.getCacheGeneration;
    p.realtimeToken = () => client.realtime.accessTokenValue;
    let releaseRead;
    p.holdNextEmptyRead = () => {
      const original = client.auth.getSession.bind(client.auth);
      client.auth.getSession = async () => {
        client.auth.getSession = original;
        const result = await original();
        if (result.data.session !== null || result.error) throw new Error('Expected a real successful empty SDK read');
        p.readHeld = true;
        await new Promise(resolve => { releaseRead = resolve; });
        return result;
      };
    };
    p.releaseRead = async () => { releaseRead(); await store.refreshCacheSession(); };
    let releasePositiveReceipt;
    p.holdNextPositiveReceipt = () => {
      const original = client.auth.getSession.bind(client.auth);
      client.auth.getSession = async () => {
        client.auth.getSession = original;
        const result = await original();
        if (!result.data.session || result.error) throw new Error('Expected a real successful positive SDK read');
        p.positiveReceiptHeld = true;
        await new Promise(resolve => { releasePositiveReceipt = resolve; });
        return result;
      };
    };
    p.releasePositiveReceipt = () => releasePositiveReceipt();
    p.holdNextSessionRead = () => { holdSessionRead = true; p.sessionReadHeld = false; };
    p.releaseSessionRead = () => releaseSessionRead();
    let releaseSdkGetSession;
    p.holdNextSdkGetSession = () => {
      const original = client.auth.getSession.bind(client.auth);
      client.auth.getSession = async (...args) => {
        client.auth.getSession = original;
        const result = await original(...args);
        p.sdkGetSessionHeld = true;
        await new Promise(resolve => { releaseSdkGetSession = resolve; });
        return result;
      };
      p.sdkGetSessionHeld = false;
    };
    p.releaseSdkGetSession = () => releaseSdkGetSession();
    p.setReadFailure = fail => { readFailure = fail; };
    p.reconcile = () => store.refreshCacheSession({ force: true });
    p.realtimeMatchesCookie = () => client.realtime.accessTokenValue === storage.captureBrowserSessionSnapshot()?.accessToken;
    p.pauseEmptyRemoval = () => { emptyReads = 2; };
    p.releaseRemoval = () => releaseRemoval();
    p.sdkSignOut = async () => { const { error } = await client.auth.signOut({ scope: 'local' }); if (error) throw error; };
    p.capture = async () => { const result = await client.auth.getSession(); if(result.error || !result.data.session) throw new Error('Expected actual saved SDK session'); return result.data.session; };
    p.stopRefresh = async () => client.auth.stopAutoRefresh();
    p.refreshGiven = async session => { const result = await client.auth.refreshSession(session); if(result.error || !result.data.session) throw new Error('Expected actual valid SDK token rotation'); return result.data.session; };
    p.closeSdkBroadcast = () => client.auth.broadcastChannel?.close();
    const external = new BroadcastChannel('sb-reconcile-fixture-auth-token');
    p.claim = async session => {
      let resolve;
      const received = new Promise(done => { resolve = done; });
      const { data: { subscription } } = client.auth.onAuthStateChange((event, value) => {
        if(event === 'TOKEN_REFRESHED' && value?.access_token === session.access_token) { subscription.unsubscribe(); resolve(); }
      });
      external.postMessage({ event: 'TOKEN_REFRESHED', session });
      await received;
    };
    p.reads = 0; p.inflight = 0;
    p.armEchoes = session => {
      const original = client.auth.getSession.bind(client.auth);
      p.restoreGetSession = () => { client.auth.getSession = original; };
      client.auth.getSession = async (...args) => {
        p.reads += 1; p.inflight += 1;
        const actual = await original(...args);
        if(actual.error || !actual.data.session) throw new Error('Expected actual positive cookie session during echo');
        await p.claim(session);
        p.inflight -= 1; return actual;
      };
    };
    p.teardown = () => { root?.unmount(); rowsRoot?.unmount(); root = undefined; rowsRoot = undefined; external.close(); };

  })();` });
}


test.use({ trace: 'off', screenshot: 'off', video: 'off' });
type Extra = Probe & { capture: () => Promise<any>; stopRefresh: () => Promise<void>; claim: (session:any) => Promise<void>; armEchoes: (session:any) => void; restoreGetSession: () => void; reads: number; inflight:number; refreshGiven:(session:any)=>Promise<any>; closeSdkBroadcast:()=>void; teardown: () => void };
async function exhaustion(context:BrowserContext,page:Page,state:ServerFixture) {
  await install(context,state); await load(page);
  await page.evaluate(() => window.__sessionReload.signIn('a'));
  const realA = await page.evaluate(() => (window.__sessionReload as Extra).capture());
  const second = await context.newPage(); await load(second);
  await second.evaluate(() => window.__sessionReload.signIn('b'));
  const realB = await second.evaluate(() => (window.__sessionReload as Extra).capture());
  const beforeB = await context.cookies(origin);
  await second.evaluate(() => (window.__sessionReload as Extra).stopRefresh());
  await page.evaluate(() => window.__sessionReload.signIn('a'));
  await page.evaluate(async () => { const p=window.__sessionReload as Extra; await p.stopRefresh(); p.mount('a'); p.mountRows('a'); });
  await expect.poll(() => page.evaluate(() => window.__sessionReload.snapshot().identity?.userId)).toBe(A);
  await expect.poll(() => page.evaluate(() => window.__sessionReload.visibleRows())).toEqual(['family-a-private-row']);
  const before = await context.cookies(origin);
  await page.clock.install({time:Date.now()});
  await page.evaluate(async value => { const p=window.__sessionReload as Extra; p.armEchoes(value); await p.claim(value); }, realB);
  await expect.poll(() => page.evaluate(() => window.__sessionReload.snapshot().status)).toBe('unavailable');
  // Clock advancement cannot flush native BroadcastChannel delivery; settle
  // each actual SDK/transport receipt before advancing the next bounded step.
  await expect.poll(() => page.evaluate(() => (window.__sessionReload as Extra).inflight)).toBe(0);
  for(let step=0;step<40;step+=1) {
    await page.clock.runFor(30_000);
    await expect.poll(() => page.evaluate(() => (window.__sessionReload as Extra).inflight)).toBe(0);
    if(await page.evaluate(() => (window.__sessionReload as Extra).reads)===16)break;
  }
  const count = await page.evaluate(() => (window.__sessionReload as Extra).reads);
  expect(count).toBe(16);
  await page.clock.runFor(12*60_000);
  expect(await page.evaluate(() => (window.__sessionReload as Extra).reads)).toBe(count);
  expect(await context.cookies(origin)).toEqual(before);
  expect(await page.evaluate(() => window.__sessionReload.visibleRows())).toEqual([]);
  await page.evaluate(() => (window.__sessionReload as Extra).restoreGetSession());
  await page.evaluate(() => window.__sessionReload.reconcile());
  return {second,realB,realA,before,beforeB};
}
const reloadButton = (page: Page) => page.getByRole('button', { name: 'Reload Bubaly', exact: true });
function stateFor() {
  const state: ServerFixture = { protected: false, family: F1, role: 'parent', failure: 'none', requests: [], grants: 0, documents: 0, chunked: false };
  return state;
}
async function recover(context: BrowserContext, page: Page, state: ServerFixture) {
  const beforeCookies = await context.cookies(origin);
  const grants = state.grants;
  const doc = await page.evaluate(() => window.__sessionReload.documentId);
  expect(await page.evaluate(() => window.__sessionReload.visibleRows())).toEqual([]);
  expect(await page.evaluate(() => (window.__sessionReload as Extra).reads)).toBe(16);
  await expect(reloadButton(page)).toBeVisible({ timeout: 700 });
  state.protected = true;
  await Promise.all([page.waitForNavigation(), reloadButton(page).click()]);
  expect(await context.cookies(origin)).toEqual(beforeCookies);
  expect(state.grants).toBe(grants);
  expect(await page.locator('[data-testid="server-refused"]').count()).toBe(0);
  await load(page, 'both', false);
  expect(await page.evaluate(() => window.__sessionReload.documentId)).not.toBe(doc);
  await page.evaluate(() => window.__sessionReload.mountServer());
  await expect.poll(() => page.evaluate(() => window.__sessionReload.snapshot().status)).toBe('ready');
  await expect.poll(() => page.evaluate(() => window.__sessionReload.visibleRows().length)).toBe(1);
  expect(state.grants).toBe(grants);
}
test('explicit recovery reloads stale-claim document with a newly authorized family and fresh rows', async ({ context, page }) => {
  const state = stateFor(); const held = await exhaustion(context, page, state);
  state.family = F3;
  await recover(context, page, state);
  await expect.poll(() => page.evaluate(() => window.__sessionReload.visibleRows())).toEqual(['current-' + F3 + '-parent']);
  expect(await page.evaluate(() => window.__sessionReload.snapshot())).toMatchObject({ status: 'ready', identity: { userId: A } });
  expect(state.requests.filter(r => r.path === '/auth/v1/user' && r.user === A).length).toBeGreaterThan(0);
  expect(state.requests.some(r => r.path === '/rest/v1/family_members' && r.user === A)).toBe(true);
  expect(state.requests.some(r => r.path === '/rest/v1/families' && r.user === A)).toBe(true);
  expect(await page.evaluate(() => window.__sessionReload.errors)).toEqual([]);
  await held.second.close();
});
test('explicit recovery uses the genuine latest owner cookies instead of the old family', async ({ context, page }) => {
  const state = stateFor(); const { beforeB, second } = await exhaustion(context, page, state);
  await context.addCookies(beforeB);
  await recover(context, page, state);
  await expect.poll(() => page.evaluate(() => window.__sessionReload.visibleRows())).toEqual(['current-' + F2 + '-parent']);
  expect(await page.evaluate(() => window.__sessionReload.snapshot())).toMatchObject({ status: 'ready', identity: { userId: B } });
  expect(state.requests.filter(r => r.path === '/auth/v1/user').every(r => r.user === B)).toBe(true);
  await second.close();
});
test('explicit recovery revalidates a same-user role and access partition without the old row', async ({ context, page }) => {
  const state = stateFor(); await exhaustion(context, page, state); state.role = 'child';
  await recover(context, page, state);
  await expect.poll(() => page.evaluate(() => window.__sessionReload.visibleRows())).toEqual(['current-' + F1 + '-child']);
  expect(await page.evaluate(() => window.__sessionReload.serverAccess.role)).toBe('child');
  expect(await page.evaluate(() => window.__sessionReload.visibleRows())).not.toContain('family-a-private-row');
});
test('chunked cookies survive explicit recovery without a new token grant', async ({ context, page }) => {
  const state = stateFor(); state.chunked = true; const { before } = await exhaustion(context, page, state);
  expect(before.filter(c => /^sb-reconcile-fixture-auth-token\.\d+$/.test(c.name)).length).toBeGreaterThan(1);
  await recover(context, page, state);
  await expect.poll(() => page.evaluate(() => window.__sessionReload.visibleRows())).toEqual(['current-' + F1 + '-parent']);
});
test('malformed competing claim remains withheld until explicit document recovery', async ({ context, page }) => {
  const state = stateFor(); const { realA, realB } = await exhaustion(context, page, state);
  await page.evaluate(value => (window.__sessionReload as Extra).claim(value), { ...realB, access_token: realA.access_token });
  await page.evaluate(() => window.__sessionReload.reconcile());
  expect(await page.evaluate(() => window.__sessionReload.snapshot().status)).toBe('unavailable');
  await recover(context, page, state);
  await expect.poll(() => page.evaluate(() => window.__sessionReload.visibleRows())).toEqual(['current-' + F1 + '-parent']);
});
test('a newer claim during a held read keeps the old rows hidden before explicit recovery', async ({ context, page }) => {
  const state = stateFor(); const { realB } = await exhaustion(context, page, state);
  await page.evaluate(() => window.__sessionReload.holdNextPositiveReceipt());
  await page.evaluate(() => { void window.__sessionReload.reconcile(); });
  await expect.poll(() => page.evaluate(() => window.__sessionReload.positiveReceiptHeld)).toBe(true);
  await page.evaluate(value => (window.__sessionReload as Extra).claim(value), realB);
  await page.evaluate(() => window.__sessionReload.releasePositiveReceipt());
  await page.evaluate(() => window.__sessionReload.reconcile());
  expect(await page.evaluate(() => window.__sessionReload.visibleRows())).toEqual([]);
  await recover(context, page, state);
  await expect.poll(() => page.evaluate(() => window.__sessionReload.visibleRows())).toEqual(['current-' + F1 + '-parent']);
});
for (const failure of ['auth', 'membership', 'missing-family'] as const) test('fresh document refuses ' + failure + ' server context rather than restoring old rows', async ({ context, page }) => {
  const state = stateFor(); await exhaustion(context, page, state);
  const cookies = await context.cookies(origin), grants = state.grants;
  await expect(reloadButton(page)).toBeVisible({ timeout: 700 });
  state.protected = true; state.failure = failure;
  await Promise.all([page.waitForNavigation(), reloadButton(page).click()]);
  await expect(page.getByTestId('server-refused')).toBeVisible();
  expect(await page.getByTestId('family-rows').count()).toBe(0);
  expect(await context.cookies(origin)).toEqual(cookies); expect(state.grants).toBe(grants);
});
test('cookie takeover after server context cannot hydrate the prior family', async ({ context, page }) => {
  const state = stateFor(); const { beforeB } = await exhaustion(context, page, state);
  state.afterContext = async () => { await context.addCookies(beforeB); };
  await expect(reloadButton(page)).toBeVisible({ timeout: 700 }); state.protected = true;
  await Promise.all([page.waitForNavigation(), reloadButton(page).click()]);
  await load(page, 'both', false); await page.evaluate(() => window.__sessionReload.mountServer());
  await expect.poll(() => page.evaluate(() => window.__sessionReload.snapshot().identity?.userId)).toBe(B);
  await expect(page.getByTestId('family-rows')).toHaveCount(0);
  expect(await page.evaluate(() => window.__sessionReload.visibleRows())).toEqual([]);
});
test('healthy current session has no unsolicited reload action', async ({ context, page }) => {
  const state = stateFor(); await install(context, state); await load(page);
  await page.evaluate(async () => { await window.__sessionReload.signIn('a'); window.__sessionReload.mount('a'); window.__sessionReload.mountRows('a'); });
  await expect.poll(() => page.evaluate(() => window.__sessionReload.visibleRows())).toEqual(['family-a-private-row']);
  await expect(reloadButton(page)).toHaveCount(0); expect(state.protected).toBe(false);
});
test('explicit local logout offers no recovery into protected cached content', async ({ context, page }) => {
  const state = stateFor(); await exhaustion(context, page, state);
  await page.evaluate(() => window.__sessionReload.sdkSignOut());
  await expect.poll(() => page.evaluate(() => window.__sessionReload.snapshot().status)).toBe('signed-out');
  await expect(reloadButton(page)).toHaveCount(0); expect(await page.evaluate(() => window.__sessionReload.visibleRows())).toEqual([]);
});
