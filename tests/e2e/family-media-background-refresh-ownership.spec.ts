import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Actual media component/hook/cookie adapter/cache observer/SDK. Only synthetic
// HTTP receipts, native fetch-ACK delivery and public browser clock are controlled.
// No provider, native Auth/RLS or production acceptance is claimed.
const { react, reactDom } = reactBrowserScripts('development');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const file = [filename, `${filename}.ts`, `${filename}.tsx`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!file) throw new Error(`Missing fixture source: ${filename}`);
  const id = path.resolve(file);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (name === 'react' || name === '@supabase/supabase-js') { item.imports[name] = name; continue; }
    const target = name.startsWith('@/') ? path.resolve(name.slice(2))
      : name.startsWith('.') && /\.tsx?$/.test(id) ? path.resolve(path.dirname(id), name)
        : require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries([
  'components/media/family-media-img.tsx',
  'lib/supabase/client.ts', 'lib/auth/cache-session.ts', 'lib/offline/cache.ts',
  'lib/storage/use-family-media.ts', 'lib/auth/browser-session-storage.ts',
].map(file => [file, collect(file)]));
const origin = 'https://media-refresh-fixture.invalid';
const provider = 'https://media-refresh-fixture.supabase.co';
const T0 = Date.parse('2026-10-23T12:00:00.000Z');
const MINUTE = 60_000;
const users = { A: '11111111-1111-4111-8111-111111111111', B: '22222222-2222-4222-8222-222222222222' };
const sessions = { A: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const object = '33333333-3333-4333-8333-333333333333/photos/synthetic.png';
const reference = `${provider}/storage/v1/object/public/family-media/${object}`;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOsAAAAASUVORK5CYII=', 'base64');
type Owner = keyof typeof users;
type Json = Record<string, unknown>;
type Signing = { id: number; bearer: string; body: Json; admittedAt: number; wireBody: string | null; responseReady: boolean; held: boolean; delivered: boolean; consumed: boolean; reader: string | null };
type Snapshot = { now: number; cookieOwner: Owner | null; sessionId: string | null; tokenVersion: string | null; token: string | null; generation: number; observedOwner: Owner | null; status: string; imageSources: string[]; busy: (string | null)[] };
type State = { errors: string[]; signRequests: { owner: Owner; version: string; body: Json; signed: string | null }[]; imageRequests: string[]; authRequests: { grant: string; owner: Owner; version: string }[] };
declare global {
  interface Window {
    __mediaRefresh: {
      errors: string[]; signings: Signing[];
      signIn: (owner: Owner) => Promise<void>;
      renew: () => Promise<void>;
      release: (id: number) => void;
      snapshot: () => Snapshot;
    };
  }
}
function receipt(owner: Owner, version: string, now: number) {
  const expires = Math.floor(now / 1000) + 24 * 60 * 60;
  const claims = { sub: users[owner], session_id: sessions[owner], exp: expires, iat: Math.floor(now / 1000), aud: 'authenticated', fixture_version: version };
  const access_token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-signature'].join('.');
  return { access_token, refresh_token: `synthetic-${version}`, token_type: 'bearer', expires_in: 86400, expires_at: expires,
    user: { id: users[owner], aud: 'authenticated', role: 'authenticated', email: `${owner.toLowerCase()}@fixture.invalid`, app_metadata: {}, user_metadata: {}, created_at: '2026-10-23T00:00:00Z' } };
}
const states = new WeakMap<Page, State>();
async function start(page: Page, context: BrowserContext, holdSecond = true): Promise<State> {
  const state: State = { errors: [], signRequests: [], imageRequests: [], authRequests: [] }; states.set(page, state);
  const minted = new Map<string, { owner: Owner; version: string; value: ReturnType<typeof receipt> }>();
  const signedImages = new Map<string, Owner>();
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') state.errors.push(message.type() + ': ' + message.text()); });
  page.on('requestfailed', request => state.errors.push('Failed browser request: ' + request.url()));
  await page.clock.install({ time: new Date(T0 - MINUTE) });
  await page.clock.pauseAt(new Date(T0));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'cache-control': 'no-store' };
    const refuse = async (reason: string) => { state.errors.push(reason); await route.abort(); };
    if (url.href === origin + '/' && request.method() === 'GET') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><main id="root"></main></body></html>' }); return;
    }
    if (url.origin !== provider) return refuse('Unexpected origin ' + url.href);
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/token' && request.method() === 'POST') {
      const body = request.postDataJSON() as Json, grant = url.searchParams.get('grant_type');
      let owner: Owner, version: string;
      if (grant === 'password') {
        const picked = (['A', 'B'] as const).find(owner => body.email === owner.toLowerCase() + '@fixture.invalid');
        if (!picked || body.password !== 'synthetic-not-real' || Object.keys(body).sort().join(',') !== 'email,gotrue_meta_security,password'
          || JSON.stringify(body.gotrue_meta_security) !== '{}') return refuse('Unexpected public password-grant envelope');
        owner = picked; version = picked + '0';
      } else if (grant === 'refresh_token') {
        if (Object.keys(body).join(',') !== 'refresh_token' || body.refresh_token !== 'synthetic-A0') return refuse('Unexpected ordinary same-session renewal envelope');
        owner = 'A'; version = 'A1';
      } else return refuse('Unexpected auth grant ' + grant);
      // The public browser clock, not host wall time, determines this synthetic
      // receipt. 24h lifetime keeps the media's 55min clock independent of Auth.
      const now = await page.evaluate(() => Date.now());
      const value = receipt(owner, version, now); minted.set(value.access_token, { owner, version, value });
      state.authRequests.push({ grant: grant!, owner, version });
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(value) }); return;
    }
    const bearer = request.headers().authorization?.replace(/^Bearer /, '') ?? '';
    const actor = minted.get(bearer);
    if (url.pathname === '/auth/v1/user' && request.method() === 'GET' && actor) {
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(actor.value.user) }); return;
    }
    if (url.pathname === '/storage/v1/object/sign/family-media' && request.method() === 'POST') {
      const body = request.postDataJSON() as Json;
      if (!actor || Object.keys(body).sort().join(',') !== 'expiresIn,paths' || body.expiresIn !== 3600
        || JSON.stringify(body.paths) !== JSON.stringify([object])) return refuse('Unexpected native Storage signing envelope');
      const signedPath = `/object/sign/family-media/${object}?token=synthetic-${actor.owner}-${state.signRequests.length + 1}`;
      const signed = actor.owner === 'A' ? provider + '/storage/v1' + signedPath : null;
      state.signRequests.push({ owner: actor.owner, version: actor.version, body, signed });
      if (signed) signedImages.set(signed, actor.owner);
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify([{ path: object, signedURL: actor.owner === 'A' ? signedPath : null, error: actor.owner === 'A' ? null : 'not authorized' }]) }); return;
    }
    if (signedImages.has(url.href) && request.method() === 'GET') {
      state.imageRequests.push(url.href);
      await route.fulfill({ contentType: 'image/png', headers, body: pixel }); return;
    }
    return refuse('Unexpected synthetic route ' + request.method() + ' ' + url.href);
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources=${JSON.stringify(modules)},entries=${JSON.stringify(entries)},loaded={};
    const process={env:{NEXT_PUBLIC_SUPABASE_URL:${JSON.stringify(provider)},NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-anon'}};
    const p=window.__mediaRefresh={errors:[],signings:[]};
    window.addEventListener('error',e=>p.errors.push(e.message));
    window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
    // Keep actual SDK/Storage methods and actual network Response bytes. Only
    // the fetch resolution of a selected native signing receipt can be held.
    const nativeFetch=window.fetch.bind(window),held=new Map();
    window.fetch=async(input,init={})=>{
      const url=new URL(typeof input==='string'?input:input.url);
      if(url.origin!==${JSON.stringify(provider)}||url.pathname!=='/storage/v1/object/sign/family-media') return nativeFetch(input,init);
      const headers=new Headers(init.headers),record={id:p.signings.length,bearer:headers.get('authorization')||'',body:JSON.parse(init.body),admittedAt:Date.now(),wireBody:null,responseReady:false,held:${JSON.stringify(holdSecond)}&&p.signings.length===1,delivered:false,consumed:false,reader:null};
      p.signings.push(record);
      const response=await nativeFetch(input,init);
      record.wireBody=await response.clone().text(); record.responseReady=true;
      for(const method of ['text','json']){
        const read=response[method].bind(response);
        response[method]=async(...args)=>{const value=await read(...args);record.consumed=true;record.reader=method;return value;};
      }
      if(record.held) return new Promise(resolve=>held.set(record.id,()=>{record.delivered=true;resolve(response);}));
      record.delivered=true;return response;
    };
    p.release=id=>{const record=p.signings.find(row=>row.id===id),release=held.get(id);if(!record?.responseReady||record.delivered||!release)throw new Error('Missing exact unreleased native ACK '+id);held.delete(id);release();};
    function load(id){
      if(id==='react')return window.React;if(id==='@supabase/supabase-js')return window.supabase;
      if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw new Error('Unknown media fixture module '+id);
      const module=loaded[id]={exports:{}};new Function('require','module','exports','process',item.source)(name=>load(item.imports[name]),module,module.exports,process);return module.exports;
    }
    const db=load(entries['lib/supabase/client.ts']).createClient();
    const auth=load(entries['lib/auth/cache-session.ts']),storage=load(entries['lib/auth/browser-session-storage.ts']),cache=load(entries['lib/offline/cache.ts']);
    const Component=load(entries['components/media/family-media-img.tsx']).FamilyMediaImg;
    const label=id=>id===${JSON.stringify(users.A)}?'A':id===${JSON.stringify(users.B)}?'B':null;
    function Observer({mirror,tick}){
      const s=React.useSyncExternalStore(auth.subscribeCacheSession,auth.getCacheSessionSnapshot,auth.getServerCacheSessionSnapshot);
      return React.createElement('section',{'data-observed-owner':label(s.identity?.userId),'data-status':s.status,'data-tick':tick},
        s.status==='ready'?React.createElement(React.Fragment,null,
          React.createElement(Component,{src:${JSON.stringify(reference)},alt:'Synthetic private image 1'}),
          mirror?React.createElement(Component,{src:${JSON.stringify(reference)},alt:'Synthetic private image 2'}):null):React.createElement('output',null,'restoring'));
    }
    function Host(){const[show,setShow]=React.useState(false),[mirror,setMirror]=React.useState(false),[tick,setTick]=React.useState(0);
      return React.createElement(React.Fragment,null,
        React.createElement('button',{onClick:()=>setShow(true)},'Show media'),
        React.createElement('button',{onClick:()=>{setShow(false);setMirror(false);}},'Hide media'),
        React.createElement('button',{onClick:()=>setMirror(true)},'Add mirror'),
        React.createElement('button',{onClick:()=>setTick(v=>v+1)},'Render tick'),
        React.createElement('output',{'data-testid':'render-tick'},tick),
        show?React.createElement(Observer,{mirror,tick}):null);
    }
    p.signIn=async(owner)=>{const{error}=await db.auth.signInWithPassword({email:owner.toLowerCase()+'@fixture.invalid',password:'synthetic-not-real'});if(error)throw error;};
    p.renew=async()=>{const{error}=await db.auth.refreshSession();if(error)throw error;};
    p.snapshot=()=>{const c=storage.captureBrowserSessionSnapshot(),s=auth.getCacheSessionSnapshot();let version=null;
      if(c?.accessToken){const b=c.accessToken.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');version=JSON.parse(atob(b.padEnd(Math.ceil(b.length/4)*4,'='))).fixture_version;}
      return {now:Date.now(),cookieOwner:label(c?.userId),sessionId:c?.sessionId??null,tokenVersion:version,token:c?.accessToken??null,generation:cache.getCacheGeneration(),observedOwner:label(s.identity?.userId),status:s.status,
        imageSources:[...document.querySelectorAll('img')].map(i=>i.src),busy:[...document.querySelectorAll('[aria-label^="Synthetic private image"]')].map(i=>i.getAttribute('aria-busy'))};};
    const root=ReactDOM.createRoot(document.getElementById('root'));ReactDOM.flushSync(()=>root.render(React.createElement(Host)));
  })();` });
  return state;
}
async function turn(page: Page) {
  await page.evaluate(async () => {
    const next = () => new Promise<void>(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(null); });
    await next(); await next();
    (window as unknown as { ReactDOM: { flushSync: (callback: () => void) => void } }).ReactDOM.flushSync(() => {});
  });
}
async function activate(page: Page, name: string) {
  // Public DOM activation avoids waiting for fake-paused rAF actionability.
  // The actual visible, enabled host button still dispatches its React event.
  const button = page.getByRole('button', { name, exact: true });
  await expect(button).toBeVisible(); await expect(button).toBeEnabled();
  await button.dispatchEvent('click'); await turn(page);
}
const snapshot = (page: Page) => page.evaluate(() => window.__mediaRefresh.snapshot());
async function consumed(page: Page, id: number) {
  await expect.poll(() => page.evaluate(id => window.__mediaRefresh.signings.find(row => row.id === id)?.consumed, id)).toBe(true);
  await turn(page);
  const call = await page.evaluate(id => window.__mediaRefresh.signings.find(row => row.id === id)!, id);
  expect(call.responseReady).toBe(true); expect(call.delivered).toBe(true); expect(['text', 'json']).toContain(call.reader);
}
async function decoded(page: Page, src: string, count = 1) {
  await expect.poll(() => page.locator('img').evaluateAll((imgs: HTMLImageElement[]) => imgs.filter(img => img.complete && img.naturalWidth === 1).map(img => img.src))).toEqual(Array(count).fill(src));
}
async function warm(page: Page, context: BrowserContext, holdSecond = true) {
  const state = await start(page, context, holdSecond);
  await page.evaluate(() => window.__mediaRefresh.signIn('A'));
  await activate(page, 'Show media');
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await consumed(page, 0);
  expect(state.signRequests.map(r => [r.owner, r.version])).toEqual([['A', 'A0']]);
  await decoded(page, state.signRequests[0].signed!);
  expect(await snapshot(page)).toMatchObject({ now: T0, cookieOwner: 'A', observedOwner: 'A', sessionId: sessions.A, tokenVersion: 'A0' });
  return state;
}
async function admitRefresh(page: Page, state: State) {
  await page.clock.runFor(55 * MINUTE - 1);
  expect((await snapshot(page)).now).toBe(T0 + 55 * MINUTE - 1);
  expect(state.signRequests).toHaveLength(1);
  await page.clock.runFor(1);
  await expect.poll(() => page.evaluate(() => window.__mediaRefresh.signings[1]?.responseReady)).toBe(true);
  const call = await page.evaluate(() => window.__mediaRefresh.signings[1]);
  expect(call.admittedAt).toBe(T0 + 55 * MINUTE); expect(call.held).toBe(true); expect(call.delivered).toBe(false); expect(call.consumed).toBe(false);
  expect(state.signRequests.map(r => [r.owner, r.version])).toEqual([['A', 'A0'], ['A', 'A0']]);
  expect(JSON.parse(call.wireBody!)[0].signedURL).toContain('token=synthetic-A-2');
  await decoded(page, state.signRequests[0].signed!);
  return call;
}
async function release(page: Page, id: number) {
  await page.evaluate(id => window.__mediaRefresh.release(id), id); await consumed(page, id);
}
async function denied(page: Page) {
  await expect(page.locator('img')).toHaveCount(0);
  const placeholder = page.locator('span[aria-label="Synthetic private image 1"]');
  await expect(placeholder).toHaveCount(1); await expect(placeholder).not.toHaveAttribute('aria-busy');
  expect(await snapshot(page)).toMatchObject({ cookieOwner: 'B', observedOwner: 'B', sessionId: sessions.B, status: 'ready', imageSources: [] });
}

test.use({ serviceWorkers: 'block' });
test.afterEach(async ({ page }, testInfo) => {
  const state = states.get(page);
  const browser = await page.evaluate(() => window.__mediaRefresh ? { errors: window.__mediaRefresh.errors, signings: window.__mediaRefresh.signings, snapshot: window.__mediaRefresh.snapshot() } : null);
  await testInfo.attach('synthetic-media-timer-transport-and-owner-state', { body: JSON.stringify({ state, browser }, null, 2), contentType: 'application/json' });
  expect(state?.errors ?? []).toEqual([]); expect(browser?.errors ?? []).toEqual([]);
});

test('a mounted same-session image refreshes once at 55 minutes and keeps its valid image until ACK', async ({ page, context }) => {
  const state = await warm(page, context); const call = await admitRefresh(page, state);
  await release(page, call.id); await decoded(page, state.signRequests[1].signed!);
  await activate(page, 'Render tick');
  await activate(page, 'Add mirror'); await turn(page);
  await decoded(page, state.signRequests[1].signed!, 2);
  expect(state.signRequests).toHaveLength(2); expect((await snapshot(page)).tokenVersion).toBe('A0');
});

test('a settled replacement-owner denial survives a late old-owner timer ACK', async ({ page, context }) => {
  const state = await warm(page, context); const call = await admitRefresh(page, state);
  const before = await snapshot(page);
  await page.evaluate(() => window.__mediaRefresh.signIn('B'));
  await consumed(page, 2); await denied(page);
  expect((await snapshot(page)).generation).toBeGreaterThan(before.generation);
  expect(state.signRequests.map(r => [r.owner, r.version])).toEqual([['A', 'A0'], ['A', 'A0'], ['B', 'B0']]);
  const imageBoundary = state.imageRequests.length;
  await release(page, call.id);
  await activate(page, 'Render tick'); await turn(page);
  await denied(page);
  expect(state.imageRequests.slice(imageBoundary)).toEqual([]); expect(state.signRequests).toHaveLength(3);
  // B settled before A: this proves denial retention, not B-pending retention.
});

test('same-session public token renewal shares the mounted pending media refresh', async ({ page, context }) => {
  const state = await warm(page, context); const call = await admitRefresh(page, state);
  const before = await snapshot(page);
  await page.evaluate(() => window.__mediaRefresh.renew());
  await expect.poll(async () => (await snapshot(page)).tokenVersion).toBe('A1');
  const after = await snapshot(page);
  expect(after.cookieOwner).toBe(before.cookieOwner); expect(after.sessionId).toBe(before.sessionId); expect(after.generation).toBe(before.generation);
  expect(after.token).not.toBe(before.token); expect(call.bearer).toBe('Bearer ' + before.token);
  await activate(page, 'Render tick');
  await activate(page, 'Add mirror'); await turn(page);
  await decoded(page, state.signRequests[0].signed!, 2); expect(state.signRequests).toHaveLength(2);
  await release(page, call.id); await decoded(page, state.signRequests[1].signed!, 2);
  expect(state.signRequests.map(r => [r.owner, r.version])).toEqual([['A', 'A0'], ['A', 'A0']]);
  expect(state.authRequests.filter(r => r.grant === 'refresh_token')).toEqual([{ grant: 'refresh_token', owner: 'A', version: 'A1' }]);
});

test('unmount cancels the media timer and a later owner mounts with an independent signature', async ({ page, context }) => {
  const state = await warm(page, context, false);
  await page.clock.runFor(54 * MINUTE);
  await activate(page, 'Hide media');
  await expect(page.locator('section[data-status]')).toHaveCount(0);
  await page.clock.runFor(2 * MINUTE); await turn(page);
  expect((await snapshot(page)).now).toBe(T0 + 56 * MINUTE); expect(state.signRequests).toHaveLength(1);
  await page.evaluate(() => window.__mediaRefresh.signIn('B'));
  const imageBoundary = state.imageRequests.length;
  await activate(page, 'Show media');
  await consumed(page, 1); await denied(page);
  expect(state.signRequests.map(r => [r.owner, r.version])).toEqual([['A', 'A0'], ['B', 'B0']]);
  expect(state.imageRequests.slice(imageBoundary)).toEqual([]);
});