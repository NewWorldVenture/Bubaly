import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Existing password entry + installed SSR/Auth SDK; finite provider HTTP only.
// Durable metadata coordinates producers, and is never an auth/cache grant.
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve(filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText : raw;
  const item: { source: string; imports: Record<string, string> } = modules[id] = { source, imports: {} };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (name === '@supabase/supabase-js') { item.imports[name] = 'sdk'; continue; }
    const target = name.startsWith('@/') ? path.resolve(name.slice(2)) + '.ts'
      : name.startsWith('.') && /\.ts$/.test(id) ? path.resolve(path.dirname(id), name) + '.ts'
        : require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entry = collect('lib/auth/password-client.ts');
const storage = collect('lib/auth/browser-session-storage.ts');
const ssr = collect(require.resolve('@supabase/ssr'));
const origin = 'https://password-admission-fixture.invalid', provider = 'https://password-admission.supabase.co';
const key = 'sb-password-admission-auth-token', dbName = 'bubaly-password-operation-v1';
const ids = { a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
type Outcome = { ok: boolean; user: string | null; error?: string };
type Probe = { login: (who: 'a' | 'b') => Promise<Outcome>; retire: () => void; clear: () => boolean;
  cookies: () => string; sdkUser: () => Promise<string | null>; events: () => string[];
  metadata: () => Promise<unknown>; disposed: () => number; errors: () => string[];
  pauseCommit: () => void; commitPaused: () => boolean; releaseCommit: () => void;
  holdNativeLock: () => Promise<void>; releaseNativeLock: () => void; lockCalls: () => number };
declare global { interface Window { __passwordAdmission: Probe } }
function user(who: 'a' | 'b') { return { id: ids[who], aud: 'authenticated', role: 'authenticated', email: who + '@synthetic.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-10-11T00:00:00Z' }; }
function session(who: 'a' | 'b', serial: number) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  return { access_token: [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: ids[who], session_id: who === 'a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', exp: expires })).toString('base64url'), 'synthetic-' + serial].join('.'),
  refresh_token: who + '-synthetic-refresh-' + serial, expires_at: expires, expires_in: 3600, token_type: 'bearer', user: user(who) };
}
type Transport = { passwords: number; users: number; holdPassword: boolean; holdUser: boolean;
  verifyMode: 'healthy' | 'different' | 'denied' | 'rejected'; rejectPassword: boolean;
  release: () => Promise<void>; requests: Array<{ path: string; method: string; who: string }> };
async function install(context: BrowserContext): Promise<Transport> {
  const held: Array<() => Promise<void>> = [];
  const state: Transport = { passwords: 0, users: 0, holdPassword: false, holdUser: false, verifyMode: 'healthy', rejectPassword: false,
    requests: [], release: async () => { state.holdPassword = false; state.holdUser = false; await Promise.all(held.splice(0).map(fn => fn())); } };
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Actual password entry fixture</body></html>' }); return; }
    if (url.origin !== provider) throw new Error('Unexpected destination: ' + url.origin);
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const body = req.postDataJSON() as Record<string, string>, who = body.email === 'b@synthetic.invalid' ? 'b' : 'a';
      expect(body.password).toBe('synthetic-password');
      const serial = ++state.passwords, rejected = state.rejectPassword;
      state.requests.push({ path: url.pathname + url.search, method: req.method(), who });
      const finish = () => state.verifyMode === 'rejected' ? route.abort('failed') : route.fulfill({ status: rejected || state.verifyMode === 'denied' ? 400 : 200, contentType: 'application/json', headers,
        body: JSON.stringify(rejected || state.verifyMode === 'denied' ? { code: 'invalid_credentials', message: 'Synthetic credentials refused' } : state.verifyMode === 'different' ? { ...session(who, serial), user: user(who === 'a' ? 'b' : 'a') } : session(who, serial)) });
      if (state.holdPassword) held.push(finish); else await finish();
      return;
    }
    if (url.pathname === '/auth/v1/user') {
      ++state.users;
      const token = req.headers().authorization?.replace(/^Bearer /, '') ?? '';
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sub: string };
      const who = claims.sub === ids.b ? 'b' : 'a', mode = state.verifyMode;
      state.requests.push({ path: url.pathname, method: req.method(), who });
      const finish = async () => {
        if (mode === 'rejected') { await route.abort('failed'); return; }
        await route.fulfill({ status: mode === 'denied' ? 401 : 200, contentType: 'application/json', headers,
          body: JSON.stringify(mode === 'denied' ? { code: 'bad_jwt', message: 'Synthetic verification refused' } : user(mode === 'different' ? who === 'a' ? 'b' : 'a' : who)) });
      };
      if (state.holdUser) held.push(finish); else await finish();
      return;
    }
    throw new Error('Unmodeled provider operation: ' + url.pathname + url.search);
  });
  return state;
}
async function load(page: Page) {
  await page.goto(origin); await page.addScriptTag({ content: sdk });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, loaded = {}, SDK = window.supabase, events = [], errors = [];
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: '${provider}', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-key' } };
    const dispose = SDK.GoTrueClient.prototype.dispose; let disposed = 0;
    SDK.GoTrueClient.prototype.dispose = async function () { disposed++; return dispose.call(this); };
    function load(id) { if (id === 'sdk') return SDK; if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw Error('Unexpected source: ' + id);
      const module = loaded[id] = { exports: {} }; new Function('require','module','exports','process',item.source)(name => load(item.imports[name]),module,module.exports,process); return module.exports; }
    const auth = load(${JSON.stringify(entry)}), storage = load(${JSON.stringify(storage)}), SSR = load(${JSON.stringify(ssr)});
    const observer = SSR.createBrowserClient('${provider}', 'synthetic-public-key', { isSingleton:false,
      auth: { autoRefreshToken:false, detectSessionInUrl:false, persistSession:true, skipAutoInitialize:true },
      cookies: { getAll: () => document.cookie.split('; ').filter(Boolean).map(s=>{const i=s.indexOf('=');return{name:s.slice(0,i),value:s.slice(i+1)}}), setAll: () => { throw Error('Observer may not write credentials'); } } });
    observer.auth.onAuthStateChange((event,session)=>{ if(event==='SIGNED_IN')events.push(session?.user.id??'none'); });
    let current = true, pauseCommit = false, commitPaused = false, releaseCommit, releaseNativeLock, lockCalls = 0;
    const nativeRequest = navigator.locks.request.bind(navigator.locks);
    const operationLock = 'bubaly:password-operation:sb-password-admission-auth-token';
    navigator.locks.request = function(name,options,callback) {
      if (name !== operationLock) return nativeRequest(name,options,callback);
      lockCalls++;
      if (pauseCommit && lockCalls === 2) return (async()=>{commitPaused=true;await new Promise(resolve=>releaseCommit=resolve);return nativeRequest(name,options,callback)})();
      return nativeRequest(name,options,callback);
    };
    window.addEventListener('error',e=>errors.push(e.message));
    window.addEventListener('unhandledrejection',e=>{errors.push(String(e.reason));e.preventDefault();});
    window.__passwordAdmission = {
      login: async who => { try { const r = await auth.signInWithOwnedSession({email:who+'@synthetic.invalid',password:'synthetic-password'},()=>current); return {ok:!r.error,user:r.data.session?.user.id??null,error:r.error?.name}; } catch(e) { return {ok:false,user:null,error:e.name}; } },
      pauseCommit: () => { pauseCommit=true; }, commitPaused:()=>commitPaused, releaseCommit:()=>{pauseCommit=false;releaseCommit();}, lockCalls:()=>lockCalls,
      holdNativeLock:()=>new Promise(resolve=>{void nativeRequest(operationLock,{mode:'exclusive'},async()=>{resolve();await new Promise(done=>releaseNativeLock=done)});}), releaseNativeLock:()=>releaseNativeLock(),
      retire: () => { current=false; }, clear: () => storage.clearBrowserSessionSnapshot(storage.captureBrowserSessionSnapshot(true)),
      cookies: () => document.cookie, events:()=>events, errors:()=>errors, disposed:()=>disposed,
      sdkUser: async () => (await observer.auth.getSession()).data.session?.user.id??null,
      metadata: async () => new Promise((resolve,reject)=>{ const r=indexedDB.open('${dbName}',1);r.onupgradeneeded=()=>r.result.createObjectStore('operations');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('operations','readonly'),q=tx.objectStore('operations').get('${key}');q.onsuccess=()=>{resolve(q.result??null);db.close()};q.onerror=()=>reject(q.error)}; }),
    };
  })();` });
}
async function noGrant(page: Page) { expect(await page.evaluate(() => window.__passwordAdmission.sdkUser())).toBeNull(); expect(await page.evaluate(() => window.__passwordAdmission.events())).toEqual([]); }
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('explicit password entry accepts one authenticated provider response before persistent SDK-readable adoption', async ({ context, page }) => {
  const state = await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordAdmission.login('a'))).toMatchObject({ ok: true, user: ids.a });
  expect(state.passwords).toBe(1); expect(state.users).toBe(0);
  expect(await page.evaluate(() => window.__passwordAdmission.sdkUser())).toBe(ids.a);
  const cookies = await context.cookies(origin), sessionCookies = cookies.filter(c => c.name === key || /^sb-password-admission-auth-token\.[0-9]+$/.test(c.name));
  expect(sessionCookies.length).toBeGreaterThan(0); for (const c of sessionCookies) { expect(c.secure).toBe(true); expect(c.sameSite).toBe('Lax'); expect(c.expires).toBeGreaterThan(Date.now() / 1000 + 300 * 86400); }
  const metadata = await page.evaluate(() => window.__passwordAdmission.metadata());
  expect(metadata).toMatchObject({ v: 1, revision: 1, phase: 'used' });
  expect(Object.keys(metadata as object).sort()).toEqual(['nonce', 'phase', 'revision', 'v']);
  expect(JSON.stringify(metadata)).not.toContain(ids.a); expect(JSON.stringify(metadata)).not.toContain('synthetic-refresh');
  expect(await page.evaluate(() => window.__passwordAdmission.disposed())).toBe(1);
});
test('a staged authenticated response cannot publish cookies or a shared SDK SIGNED_IN event before current admission', async ({ context, page }) => {
  const state = await install(context); await load(page); await page.evaluate(()=>window.__passwordAdmission.pauseCommit());
  const result = page.evaluate(() => window.__passwordAdmission.login('a'));
  await expect.poll(() => page.evaluate(()=>window.__passwordAdmission.commitPaused())).toBe(true); await noGrant(page);
  expect((await context.cookies(origin)).filter(c => c.name === key || c.name.startsWith(key + '.'))).toEqual([]);
  await page.evaluate(()=>window.__passwordAdmission.releaseCommit()); expect(await result).toMatchObject({ ok: true, user: ids.a });
});
for (const mode of ['different', 'denied', 'rejected'] as const) test(`${mode} authenticated password response exposes no accepted session`, async ({ context, page }) => {
  const state = await install(context); state.verifyMode = mode; await load(page);
  expect(await page.evaluate(() => window.__passwordAdmission.login('a'))).toMatchObject({ ok: false, user: null });
  expect(state.users).toBe(0); await noGrant(page);
});
for (const denial of ['storage', 'locks', 'durability'] as const) test(`${denial} denial refuses before a provider operation or credential grant`, async ({ context, page }) => {
  const state = await install(context); await load(page);
  await page.evaluate(denial => {
    if (denial === 'storage') Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new DOMException('Synthetic denied', 'SecurityError'); } } });
    else if (denial === 'locks') Object.defineProperty(navigator, 'locks', { value: undefined });
    else { const original = IDBDatabase.prototype.transaction; IDBDatabase.prototype.transaction = function (...args) { const tx=original.apply(this,args); Object.defineProperty(tx,'durability',{value:'relaxed'}); return tx; }; }
  }, denial);
  expect(await page.evaluate(() => window.__passwordAdmission.login('a'))).toMatchObject({ ok: false, user: null }); expect(state.passwords).toBe(0); expect(state.users).toBe(0); await noGrant(page);
});
test('malformed durable metadata cannot be replaced with an apparent current owner', async ({ context, page }) => {
  const state=await install(context);await load(page);await page.evaluate(async ({dbName,key}) => { await new Promise<void>((resolve,reject)=>{const r=indexedDB.open(dbName,1);r.onupgradeneeded=()=>r.result.createObjectStore('operations');r.onsuccess=()=>{const db=r.result,tx=db.transaction('operations','readwrite');tx.objectStore('operations').put({v:1,revision:1,nonce:'invalid',phase:'pending'},key);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)};r.onerror=()=>reject(r.error)}); },{dbName,key});
  expect(await page.evaluate(()=>window.__passwordAdmission.login('a'))).toMatchObject({ok:false});expect(state.passwords).toBe(0);await noGrant(page);
});
for (const newer of ['a','b'] as const) test(`a second tab's admitted ${newer} session survives A's late authenticated result`,async({context,page})=>{
  const state=await install(context);await load(page);await page.evaluate(()=>window.__passwordAdmission.pauseCommit());const first=page.evaluate(()=>window.__passwordAdmission.login('a'));await expect.poll(()=>page.evaluate(()=>window.__passwordAdmission.commitPaused())).toBe(true);
  const other=await context.newPage();await load(other);state.holdUser=false;
  expect(await other.evaluate(who=>window.__passwordAdmission.login(who),newer)).toMatchObject({ok:true,user:ids[newer]});
  const before=await context.cookies(origin);await page.evaluate(()=>window.__passwordAdmission.releaseCommit());expect(await first).toMatchObject({ok:false,user:null});expect(await context.cookies(origin)).toEqual(before);
  expect(await other.evaluate(()=>window.__passwordAdmission.sdkUser())).toBe(ids[newer]);
});
test('existing local logout retires a held password adoption before asynchronous completion',async({context,page})=>{
  const state=await install(context);await load(page);await page.evaluate(()=>window.__passwordAdmission.pauseCommit());const first=page.evaluate(()=>window.__passwordAdmission.login('a'));await expect.poll(()=>page.evaluate(()=>window.__passwordAdmission.commitPaused())).toBe(true);
  expect(await page.evaluate(()=>window.__passwordAdmission.clear())).toBe(true);const before=await context.cookies(origin);await page.evaluate(()=>window.__passwordAdmission.releaseCommit());expect(await first).toMatchObject({ok:false,user:null});expect(await context.cookies(origin)).toEqual(before);await noGrant(page);
});
test('a retired component decision cannot adopt a delayed provider response',async({context,page})=>{
  const state=await install(context);state.holdPassword=true;await load(page);const first=page.evaluate(()=>window.__passwordAdmission.login('a'));await expect.poll(()=>state.passwords).toBe(1);
  await page.evaluate(()=>window.__passwordAdmission.retire());const before=await context.cookies(origin);await state.release();expect(await first).toMatchObject({ok:false,user:null});expect(await context.cookies(origin)).toEqual(before);expect(state.users).toBe(0);await noGrant(page);
});
test('an explicit retry after rejected credentials replaces only metadata and can verify a new identity',async({context,page})=>{
  const state=await install(context);state.rejectPassword=true;await load(page);expect(await page.evaluate(()=>window.__passwordAdmission.login('a'))).toMatchObject({ok:false});await noGrant(page);
  state.rejectPassword=false;expect(await page.evaluate(()=>window.__passwordAdmission.login('b'))).toMatchObject({ok:true,user:ids.b});expect(state.passwords).toBe(2);expect(state.users).toBe(0);expect(await page.evaluate(()=>window.__passwordAdmission.metadata())).toMatchObject({revision:2,phase:'used'});
});
test('refused native cookie projection reports failure without a shared SDK credential event',async({context,page})=>{
  const state=await install(context);await load(page);await page.evaluate(key=>{const d=Object.getOwnPropertyDescriptor(Document.prototype,'cookie')!;Object.defineProperty(document,'cookie',{get:()=>d.get!.call(document),set:value=>{if(!String(value).startsWith(key+'=')&&!new RegExp('^'+key+'\\.').test(String(value)))d.set!.call(document,value)}})},key);
  expect(await page.evaluate(()=>window.__passwordAdmission.login('a'))).toMatchObject({ok:false,user:null});expect(state.users).toBe(0);await noGrant(page);
});
test('an already retired deliberate action has no admission/provider side effects',async({context,page})=>{
  const state=await install(context);await load(page);await page.evaluate(()=>window.__passwordAdmission.retire());expect(await page.evaluate(()=>window.__passwordAdmission.login('a'))).toMatchObject({ok:false});expect(state.passwords).toBe(0);expect(await page.evaluate(()=>window.__passwordAdmission.metadata())).toBeNull();
});

test('an actual held native WebLock delays adoption and local logout retires it before release',async({context,page})=>{
  const state=await install(context);state.holdPassword=true;await load(page);const first=page.evaluate(()=>window.__passwordAdmission.login('a'));await expect.poll(()=>state.passwords).toBe(1);
  const other=await context.newPage();await load(other);await other.evaluate(()=>window.__passwordAdmission.holdNativeLock());
  await state.release();await expect.poll(()=>page.evaluate(()=>window.__passwordAdmission.lockCalls())).toBe(2);await noGrant(page);
  expect(await page.evaluate(()=>window.__passwordAdmission.clear())).toBe(true);const before=await context.cookies(origin);
  await other.evaluate(()=>window.__passwordAdmission.releaseNativeLock());expect(await first).toMatchObject({ok:false,user:null});expect(await context.cookies(origin)).toEqual(before);
  expect(state.users).toBe(0);expect(state.passwords).toBe(1);
});
