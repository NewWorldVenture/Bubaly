import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { callbackAdmissionMaterial, type CallbackAdmissionWitness } from '../../lib/auth/callback-witness';
import { encodePkceInitiationRecord, parsePkceInitiationRecord, type PkceInitiationKind } from '../../lib/auth/pkce-initiation';

// Production helper, browser storage and cache store with the installed SDK.
// Provider HTTP and named scheduling barriers are controlled; no live accounts.
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve(filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (name === '@supabase/supabase-js') { item.imports[name] = 'sdk'; continue; }
    let target: string;
    if (name.startsWith('@/')) target = path.resolve(name.slice(2)) + '.ts';
    else if (name.startsWith('.') && /\.ts$/.test(id)) target = path.resolve(path.dirname(id), name) + '.ts';
    else target = require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entry = collect('lib/auth/password-client.ts');
const callbackEntry = collect('lib/auth/callback-client.ts');
const browserEntry = collect('lib/supabase/client.ts');
const storageEntry = collect('lib/auth/browser-session-storage.ts');
const cacheEntry = collect('lib/auth/cache-session.ts');
const signalEntry = collect('lib/auth/session-change.ts');
const logoutEntry = collect('lib/auth/browser-signout.ts');
const ssrEntry = collect(require.resolve('@supabase/ssr'));
const origin = 'https://password-ownership-fixture.invalid';
const provider = 'https://password-owner.supabase.co';
const key = 'sb-password-owner-auth-token';
const initiationNonce = '0123456789abcdef0123456789abcdef';
const initiationKey = `${key}-pkce-initiation`;
const ids = { a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
type Result = { ok: boolean; user: string | null; current: boolean; error?: string };
type Probe = {
  signIn: (who?: 'a' | 'b') => Promise<Result>; retire: () => void;
  tokenSignIn: () => Promise<Result>; releaseTokens: (tokens: { access_token: string; refresh_token: string }) => void;
  tokensPending: () => boolean; setSessionCalls: () => number; disposedClients: () => number;
  sharedSignIn: (who: 'a' | 'b') => Promise<void>; storedUser: () => string | null;
  refresh: () => Promise<Result>;
  fallbackRead: (method: 'getUser' | 'getSession') => Promise<{ user: string | null; ownerCurrent: boolean; error?: string }>;
  captureCallback: () => boolean; callbackFingerprint: () => Promise<string | null>; callbackCurrent: () => boolean;
  adoptCallback: (tokens: { access_token: string; refresh_token: string }) => Promise<Result>; adoptedCallbackCurrent: () => boolean;
  adoptAfterAdmission: (tokens: { access_token: string; refresh_token: string }, witness: unknown, attempt?: string | null, recovery?: boolean) => Promise<Result>;
  admissionCurrent: (witness: unknown) => Promise<boolean>;
  initiationCurrent: (attempt?: string | null, recovery?: boolean) => Promise<boolean>;
  pauseDigest: () => void; digestPaused: () => boolean; releaseDigest: () => void;
  clearRefusingVerifier: () => boolean;
  snapshot: () => unknown; clear: () => boolean; lastCurrent: () => boolean;
  captureLogout: () => void; clearCaptured: () => string;
  observe: () => void; cacheUser: () => string | null; signals: () => number;
  pauseWrite: () => void; writePaused: () => boolean; releaseWrite: () => void;
  pauseRefreshWrite: () => void; refreshWritePaused: () => boolean; releaseRefreshWrite: () => void;
  events: () => string[]; errors: () => string[];
};
declare global { interface Window { __passwordOwner: Probe } }
type Mode = 'valid' | 'missing-user' | 'bad-user' | 'mismatched-subject' | 'different-session' | 'expired-token' | 'missing-token' | 'incomplete' | 'unreadable' | 'reject' | 'unavailable' | 'network';
function session(who: 'a' | 'b', padding = 0, expired = false) {
  const expires = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: ids[who], session_id: who === 'a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
      exp: expires })).toString('base64url'), 'synthetic-signature'].join('.');
  return { access_token: token, refresh_token: who + '-synthetic-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expires,
    user: { id: ids[who], aud: 'authenticated', role: 'authenticated', email: who + '@fixture.invalid', app_metadata: {},
      user_metadata: padding ? { padding: 'x'.repeat(padding) } : {}, created_at: '2026-09-12T00:00:00Z' } };
}
async function install(context: BrowserContext) {
  let mode: Mode = 'valid';
  let held: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const requests: string[] = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Password ownership fixture</body></html>' }); return;
    }
    if (url.origin !== provider) throw new Error('Unexpected fixture origin: ' + url.origin);
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    requests.push(url.pathname + url.search);
    if (url.pathname === '/auth/v1/user') {
      if (mode === 'reject') { await route.fulfill({ status: 401, headers, contentType: 'application/json', body: JSON.stringify({ code: 'bad_jwt', message: 'Controlled token rejection' }) }); return; }
      const claims = JSON.parse(Buffer.from(route.request().headers().authorization!.slice(7).split('.')[1], 'base64url').toString());
      const who = claims.sub === ids.b ? 'b' : 'a';
      await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(session(who).user) }); return;
    }
    if (url.pathname !== '/auth/v1/token') throw new Error('Unexpected fixture request: ' + url.pathname);
    const body = route.request().postDataJSON() as { email?: string; refresh_token?: string };
    const who = body.email?.startsWith('b@') || body.refresh_token?.startsWith('b-') ? 'b' : 'a';
    const chosen = who === 'a' ? mode : 'valid';
    if (who === 'a' && held) await held;
    if (chosen === 'network') { await route.abort('failed'); return; }
    let result: unknown = session(who);
    if (url.searchParams.get('grant_type') === 'refresh_token') {
      const rotated = session(who);
      const parts = rotated.access_token.split('.');
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      parts[1] = Buffer.from(JSON.stringify({ ...claims, rotation: requests.length })).toString('base64url');
      result = { ...rotated, access_token: parts.join('.'), refresh_token: who + '-rotated-refresh' };
    }
    if (chosen === 'missing-user') { const { user: _user, ...rest } = session(who); result = rest; }
    if (chosen === 'bad-user') result = { ...session(who), user: { ...session(who).user, id: 'not-an-identifier' } };
    if (chosen === 'mismatched-subject') result = { ...session(who), user: session(who === 'a' ? 'b' : 'a').user };
    if (chosen === 'expired-token') result = { ...session(who), access_token: session(who, 0, true).access_token };
    if (chosen === 'different-session') {
      const original = session(who);
      const parts = original.access_token.split('.');
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      parts[1] = Buffer.from(JSON.stringify({ ...claims, session_id: '33333333-3333-4333-8333-333333333333' })).toString('base64url');
      result = { ...original, access_token: parts.join('.') };
    }
    if (chosen === 'missing-token') result = { ...session(who), refresh_token: '' };
    if (chosen === 'incomplete') result = {};
    if (chosen === 'reject' || chosen === 'unavailable') result = { message: 'Controlled provider rejection', code: 'invalid_credentials' };
    await route.fulfill({ headers, status: chosen === 'reject' ? 400 : chosen === 'unavailable' ? 503 : 200, contentType: 'application/json',
      body: chosen === 'unreadable' ? '{invalid' : JSON.stringify(result) });
  });
  return { requests, mode: (value: Mode) => { mode = value; }, hold: () => { held = new Promise(resolve => { release = resolve; }); },
    release: () => { release?.(); held = undefined; } };
}
async function load(page: Page, pathname = '') {
  await page.goto(origin + pathname);
  await page.addScriptTag({ content: sdk });
  const bootstrap = String.raw`function boot({sources,entry,callbackEntry,browserEntry,storageEntry,cacheEntry,signalEntry,logoutEntry,ssrEntry,provider,key,initiationNonce}) {
 const loaded={}; const process={env:{NEXT_PUBLIC_SUPABASE_URL:provider,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key'}};
 let pause=false,paused=false,release,setSessionCalls=0,disposedClients=0,pauseRefresh=false,refreshPaused=false,releaseRefresh,pauseDigest=false,digestPaused=false,releaseDigest;
 const digest=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=async(...args)=>{
  if(pauseDigest){pauseDigest=false;digestPaused=true;await new Promise(resolve=>{releaseDigest=resolve;});}return digest(...args);
 };
 function load(id){
  if(id==='sdk')return window.supabase;
  if(loaded[id])return loaded[id].exports;
  const item=sources[id];if(!item)throw new Error('Unexpected fixture module: '+id);
  const module=loaded[id]={exports:{}};
  new Function('require','module','exports','process',item.source)(name=>load(item.imports[name]),module,module.exports,process);
  if(id===ssrEntry){const real=module.exports;module.exports={...real,createBrowserClient:(url,pubkey,options)=>{
   if(options?.isSingleton===false&&options.cookies?.setAll){const write=options.cookies.setAll;options.cookies.setAll=async cookies=>{
    if(pause&&cookies.some(cookie=>cookie.name.startsWith(key)&&cookie.options.maxAge!==0)){pause=false;paused=true;await new Promise(resolve=>{release=resolve;});}
    return write(cookies);
   };}const client=real.createBrowserClient(url,pubkey,options);if(options?.isSingleton===false){const set=client.auth.setSession.bind(client.auth),dispose=client.auth.dispose.bind(client.auth);client.auth.setSession=(...args)=>{setSessionCalls++;return set(...args);};client.auth.dispose=async()=>{disposedClients++;return dispose();};}return client;
  }};}
  return module.exports;
 }
 const helper=load(entry),callback=load(callbackEntry),storage=load(storageEntry),browser=load(browserEntry),cache=load(cacheEntry),signal=load(signalEntry),logout=load(logoutEntry);
 const makeStorage=storage.createBrowserSessionStorage;storage.createBrowserSessionStorage=url=>{
  const adapter=makeStorage(url),write=adapter.cookies.setAll;adapter.cookies.setAll=async cookies=>{
   if(pauseRefresh&&cookies.some(cookie=>cookie.name===key&&cookie.options.maxAge!==0)){pauseRefresh=false;refreshPaused=true;await new Promise(resolve=>{releaseRefresh=resolve;});}
   return write(cookies);
  };return adapter;
 };
 let active=true,last=null,signalCount=0,observing=false,releaseTokens,callbackOwner,capturedLogout;
 const events=[],errors=[];
 window.addEventListener('error',event=>errors.push(event.message));
 window.addEventListener('unhandledrejection',event=>{errors.push(String(event.reason));event.preventDefault();});
 const record=async work=>{try{const result=await work;last=result.data?.session??null;return {ok:!result.error&&!!last,user:result.data?.user?.id??null,current:!!last&&helper.isPasswordSessionCurrent(last),error:result.error?.name};}catch(error){return {ok:false,user:null,current:false,error:error.name};}};
 window.__passwordOwner={
  signIn:(who='a')=>record(helper.signInWithOwnedSession({email:who+'@fixture.invalid',password:'synthetic-password'},()=>active)),
  tokenSignIn:()=>record(helper.signInWithOwnedSessionTokens(()=>new Promise(resolve=>{releaseTokens=resolve;}),()=>active)),
  releaseTokens:tokens=>{releaseTokens?.(tokens);},tokensPending:()=>typeof releaseTokens==='function',setSessionCalls:()=>setSessionCalls,disposedClients:()=>disposedClients,
  retire:()=>{active=false;},
  sharedSignIn:async who=>{const result=await browser.createClient().auth.signInWithPassword({email:who+'@fixture.invalid',password:'synthetic-password'});if(result.error)throw result.error;},
  refresh:()=>record(browser.createClient().auth.refreshSession()),
  fallbackRead:async method=>{try{const result=await browser.createClient().auth[method]();return {user:result.data.user?.id??result.data.session?.user?.id??null,ownerCurrent:!!callbackOwner&&callback.isCallbackOwnershipCurrent(callbackOwner),error:result.error?.name};}catch(error){return {user:null,ownerCurrent:!!callbackOwner&&callback.isCallbackOwnershipCurrent(callbackOwner),error:error.name};}},
  captureCallback:()=>{callbackOwner=callback.captureCallbackOwnership();return !!callbackOwner;},
  callbackFingerprint:async()=>{try{return await callback.callbackVerifierFingerprint(callbackOwner);}catch{return null;}},
  callbackCurrent:()=>!!callbackOwner&&callback.isCallbackOwnershipCurrent(callbackOwner),
  adoptCallback:tokens=>record(callback.adoptCallbackSession(tokens,callbackOwner,()=>active)),
  adoptAfterAdmission:async(tokens,witness,attempt=initiationNonce,recovery=false)=>await callback.assertAdmissionOwnership(callbackOwner,witness)&&await callback.assertInitiationOwnership(callbackOwner,attempt,recovery)?record(callback.adoptCallbackSession(tokens,callbackOwner,()=>active)):{ok:false,user:null,current:false},
  admissionCurrent:witness=>callback.assertAdmissionOwnership(callbackOwner,witness),
  initiationCurrent:(attempt=initiationNonce,recovery=false)=>callback.assertInitiationOwnership(callbackOwner,attempt,recovery),
  pauseDigest:()=>{pauseDigest=true;},digestPaused:()=>digestPaused,releaseDigest:()=>{releaseDigest?.();},
  clearRefusingVerifier:()=>{
   const own=Object.getOwnPropertyDescriptor(document,'cookie'),descriptor=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
   Object.defineProperty(document,'cookie',{configurable:true,get:()=>descriptor.get.call(document),set:value=>{if(!String(value).startsWith(key+'-code-verifier=')&&!String(value).startsWith(key+'-pkce-initiation='))descriptor.set.call(document,value);}});
   try{return storage.clearBrowserSessionSnapshot(storage.captureBrowserSessionSnapshot(true));}catch{return false;}
   finally{if(own)Object.defineProperty(document,'cookie',own);else delete document.cookie;}
  },
  adoptedCallbackCurrent:()=>!!last&&!!callbackOwner&&callback.isAdoptedCallbackSessionCurrent(last,callbackOwner),
  storedUser:()=>storage.captureBrowserSessionSnapshot()?.userId??null,snapshot:storage.captureBrowserSessionSnapshot,
  clear:()=>storage.clearBrowserSessionSnapshot(storage.captureBrowserSessionSnapshot(true)),
  captureLogout:()=>{capturedLogout=logout.captureSignOutIntent();},clearCaptured:()=>logout.signOutBrowserSession(capturedLogout,{revoke:false}).status,
  lastCurrent:()=>!!last&&helper.isPasswordSessionCurrent(last),
  observe:()=>{if(observing)return;observing=true;signal.subscribeSessionStorageChanges(()=>{signalCount++;});cache.subscribeCacheSession(()=>{});browser.createClient().auth.onAuthStateChange(event=>events.push(event));},
  cacheUser:()=>cache.getCacheSessionSnapshot().identity?.userId??null,signals:()=>signalCount,
  pauseWrite:()=>{pause=true;},writePaused:()=>paused,releaseWrite:()=>{release?.();},
  pauseRefreshWrite:()=>{pauseRefresh=true;},refreshWritePaused:()=>refreshPaused,releaseRefreshWrite:()=>{releaseRefresh?.();},
  events:()=>events,errors:()=>errors
 };
}
`;
  await page.addScriptTag({ content: '(' + bootstrap + ')(' + JSON.stringify({ sources: modules, entry, callbackEntry, browserEntry, storageEntry, cacheEntry, signalEntry, logoutEntry, ssrEntry, provider, key, initiationNonce }) + ');' });
}
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

function expectOnlyNewSessionReservation(before: unknown, after: unknown) {
  expect(before).toBeTruthy(); expect(after).toBeTruthy();
  const original = before as { cookies: Array<{ name: string; value: string }> };
  const current = after as { cookies: Array<{ name: string; value: string }> };
  const reservations = current.cookies.filter(cookie => cookie.name === initiationKey);
  expect(reservations).toHaveLength(1);
  expect(reservations[0].value).toMatch(/^session-v1-[a-f0-9]{32}$/);
  expect(reservations[0].value).not.toBe(original.cookies.find(cookie => cookie.name === initiationKey)?.value);
  // A deliberate attempt replaces exactly its decision marker. Every original
  // session/verifier byte and every parsed identity/logout-generation field stays exact.
  expect(current).toEqual({ ...original, cookies: [...original.cookies.filter(cookie => cookie.name !== initiationKey), reservations[0]]
    .sort((a, b) => a.name.localeCompare(b.name)) });
}

test('valid password receipt is durably adopted and matches the browser session', async ({ context, page }) => {
  await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: true, user: ids.a, current: true });
  const cookie = (await context.cookies(origin)).find(item => item.name === key)!;
  expect(cookie).toMatchObject({ secure: true, sameSite: 'Lax', path: '/' });
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 390 * 86400);
  await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.storedUser())).toBe(ids.a);
});

for (const mode of ['missing-user', 'bad-user', 'mismatched-subject', 'expired-token', 'missing-token', 'incomplete', 'unreadable', 'reject', 'unavailable', 'network'] as const) {
  test(mode + ' receipt preserves the current B session', async ({ context, page }) => {
    const control = await install(context); await load(page);
    await page.evaluate(() => window.__passwordOwner.sharedSignIn('b'));
    const before = await page.evaluate(() => window.__passwordOwner.snapshot());
    control.mode(mode);
    expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: false, current: false });
    expectOnlyNewSessionReservation(before, await page.evaluate(() => window.__passwordOwner.snapshot()));
  });
}

test('a delayed A response cannot replace B adopted by another tab', async ({ context, page }) => {
  const control = await install(context); await load(page);
  const other = await context.newPage(); await load(other);
  control.hold();
  const signingIn = page.evaluate(() => window.__passwordOwner.signIn());
  await expect.poll(() => control.requests.length).toBe(1);
  await other.evaluate(() => window.__passwordOwner.sharedSignIn('b'));
  const before = await other.evaluate(() => window.__passwordOwner.snapshot());
  control.release();
  expect(await signingIn).toMatchObject({ ok: false, current: false });
  expect(await other.evaluate(() => window.__passwordOwner.snapshot())).toEqual(before);
});

test('explicit logout of an empty slot cancels a delayed password attempt', async ({ context, page }) => {
  const control = await install(context); await load(page);
  const other = await context.newPage(); await load(other);
  control.hold();
  const signingIn = page.evaluate(() => window.__passwordOwner.signIn());
  await expect.poll(() => control.requests.length).toBe(1);
  expect(await other.evaluate(() => window.__passwordOwner.clear())).toBe(true);
  control.release();
  expect(await signingIn).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__passwordOwner.snapshot())).toBeNull();
});

test('retired UI intent cannot publish its delayed password response', async ({ context, page }) => {
  const control = await install(context); await load(page);
  control.hold();
  const signingIn = page.evaluate(() => window.__passwordOwner.signIn());
  await expect.poll(() => control.requests.length).toBe(1);
  await page.evaluate(() => window.__passwordOwner.retire());
  control.release();
  expect(await signingIn).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__passwordOwner.snapshot())).toBeNull();
});

test('the final SDK cookie-write boundary rechecks a newer B login', async ({ context, page }) => {
  await install(context); await load(page);
  const other = await context.newPage(); await load(other);
  await page.evaluate(() => window.__passwordOwner.pauseWrite());
  const signingIn = page.evaluate(() => window.__passwordOwner.signIn());
  await expect.poll(() => page.evaluate(() => window.__passwordOwner.writePaused())).toBe(true);
  await other.evaluate(() => window.__passwordOwner.sharedSignIn('b'));
  await page.evaluate(() => window.__passwordOwner.releaseWrite());
  expect(await signingIn).toMatchObject({ ok: false });
  expect(await other.evaluate(() => window.__passwordOwner.storedUser())).toBe(ids.b);
});

test('isolated INITIAL_SESSION does not refresh an expired ambient B session', async ({ context, page }) => {
  const control = await install(context); await load(page);
  const stored = session('b', 0, true);
  await context.addCookies([{ name: key, value: 'base64-' + Buffer.from(JSON.stringify(stored)).toString('base64url'), url: origin }]);
  expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: true, user: ids.a, current: true });
  expect(control.requests).toEqual(['/auth/v1/token?grant_type=password']);
});

test('password adoption removes old chunks while preserving an unrelated verifier and cookies', async ({ context, page }) => {
  await install(context); await load(page);
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session('b', 20000))).toString('base64url');
  const chunks = [];
  for (let index = 0; index * 2500 < encoded.length; index++) chunks.push({ name: key + '.' + index, value: encoded.slice(index * 2500, (index + 1) * 2500), url: origin });
  await context.addCookies([...chunks, { name: key + '-code-verifier', value: 'unrelated-pending-verifier', url: origin },
    { name: 'sb-other-auth-token', value: 'other-project', url: origin }]);
  expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: true, current: true });
  const cookies = await context.cookies(origin);
  expect(cookies.some(cookie => cookie.name.startsWith(key + '.'))).toBe(false);
  expect(cookies.find(cookie => cookie.name === key + '-code-verifier')?.value).toBe('unrelated-pending-verifier');
  expect(cookies.find(cookie => cookie.name === 'sb-other-auth-token')?.value).toBe('other-project');
});

test('denied cookie writes cannot produce a successful adoption receipt', async ({ context, page }) => {
  await install(context); await load(page);
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => descriptor.get!.call(document), set: () => {} });
  });
  expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: false, current: false });
  expect(await page.evaluate(() => window.__passwordOwner.snapshot())).toBeNull();
});

for (const disabled of [false, true]) {
  test('verified adoption reconciles the same-tab cache' + (disabled ? ' without BroadcastChannel' : ''), async ({ context, page }) => {
    if (disabled) await context.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined }); });
    await install(context); await load(page);
    await page.evaluate(() => window.__passwordOwner.observe());
    expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: true, current: true });
    await expect.poll(() => page.evaluate(() => window.__passwordOwner.cacheUser())).toBe(ids.a);
    expect(await page.evaluate(() => window.__passwordOwner.signals())).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__passwordOwner.errors())).toEqual([]);
  });
}

test('verified adoption reconciles another tab through the storage-event fallback', async ({ context, page }) => {
  await context.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined }); });
  await install(context); await load(page);
  const other = await context.newPage(); await load(other);
  await page.evaluate(() => window.__passwordOwner.observe());
  await other.evaluate(() => window.__passwordOwner.observe());
  expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: true });
  await expect.poll(() => other.evaluate(() => window.__passwordOwner.cacheUser())).toBe(ids.a);
  expect(await other.evaluate(() => window.__passwordOwner.signals())).toBeGreaterThan(0);
  expect(await other.evaluate(() => window.__passwordOwner.errors())).toEqual([]);
});

test('a receipt loses ownership after another session is saved', async ({ context, page }) => {
  await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: true, current: true });
  await page.evaluate(() => window.__passwordOwner.sharedSignIn('b'));
  expect(await page.evaluate(() => window.__passwordOwner.lastCurrent())).toBe(false);
});


test('received server tokens are verified by the SDK before durable adoption', async ({ context, page }) => {
  const control = await install(context); await load(page);
  const signingIn = page.evaluate(() => window.__passwordOwner.tokenSignIn());
  await expect.poll(() => page.evaluate(() => window.__passwordOwner.tokensPending())).toBe(true);
  await page.evaluate(tokens => window.__passwordOwner.releaseTokens(tokens), session('a'));
  expect(await signingIn).toMatchObject({ ok: true, user: ids.a, current: true });
  expect(control.requests).toEqual(['/auth/v1/user']);
  expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(1);
  expect(await page.evaluate(() => window.__passwordOwner.disposedClients())).toBe(1);
});

test('server tokens rejected by the provider leave the existing B session intact', async ({ context, page }) => {
  const control = await install(context); await load(page);
  await page.evaluate(() => window.__passwordOwner.sharedSignIn('b'));
  const before = await page.evaluate(() => window.__passwordOwner.snapshot());
  control.mode('reject');
  const signingIn = page.evaluate(() => window.__passwordOwner.tokenSignIn());
  await expect.poll(() => page.evaluate(() => window.__passwordOwner.tokensPending())).toBe(true);
  await page.evaluate(tokens => window.__passwordOwner.releaseTokens(tokens), session('a'));
  expect(await signingIn).toMatchObject({ ok: false, current: false });
  expect(control.requests).toEqual(['/auth/v1/token?grant_type=password', '/auth/v1/user']);
  expectOnlyNewSessionReservation(before, await page.evaluate(() => window.__passwordOwner.snapshot()));
});

test('B adopted while server tokens are pending prevents any A SDK installation', async ({ context, page }) => {
  const control = await install(context); await load(page);
  const other = await context.newPage(); await load(other);
  const signingIn = page.evaluate(() => window.__passwordOwner.tokenSignIn());
  await expect.poll(() => page.evaluate(() => window.__passwordOwner.tokensPending())).toBe(true);
  await other.evaluate(() => window.__passwordOwner.sharedSignIn('b'));
  const before = await other.evaluate(() => window.__passwordOwner.snapshot());
  await page.evaluate(tokens => window.__passwordOwner.releaseTokens(tokens), session('a'));
  expect(await signingIn).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
  expect(control.requests).toEqual(['/auth/v1/token?grant_type=password']);
  expect(await other.evaluate(() => window.__passwordOwner.snapshot())).toEqual(before);
});

test('server tokens arriving after the deadline cannot restart the disposed SDK', async ({ context, page }) => {
  const control = await install(context); await load(page); await page.clock.install();
  const signingIn = page.evaluate(() => window.__passwordOwner.tokenSignIn());
  await expect.poll(() => page.evaluate(() => window.__passwordOwner.tokensPending())).toBe(true);
  await page.clock.runFor(20_100);
  expect(await signingIn).toMatchObject({ ok: false, error: 'AuthRetryableFetchError' });
  expect(await page.evaluate(() => window.__passwordOwner.disposedClients())).toBe(1);
  await page.evaluate(tokens => window.__passwordOwner.releaseTokens(tokens), session('a', 0, true));
  await page.clock.runFor(40_000);
  expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
  expect(control.requests).toEqual([]);
  expect(await page.evaluate(() => window.__passwordOwner.snapshot())).toBeNull();
  expect(await page.evaluate(() => window.__passwordOwner.errors())).toEqual([]);
});

test('the deadline closes the last SDK write before a late response can overwrite B', async ({ context, page }) => {
  await install(context); await load(page); await page.clock.install();
  const other = await context.newPage(); await load(other);
  await page.evaluate(() => window.__passwordOwner.pauseWrite());
  const signingIn = page.evaluate(() => window.__passwordOwner.signIn());
  await expect.poll(() => page.evaluate(() => window.__passwordOwner.writePaused())).toBe(true);
  await page.clock.runFor(20_100);
  expect(await signingIn).toMatchObject({ ok: false, error: 'AuthRetryableFetchError' });
  expect(await page.evaluate(() => window.__passwordOwner.disposedClients())).toBe(1);
  await other.evaluate(() => window.__passwordOwner.sharedSignIn('b'));
  await page.evaluate(() => window.__passwordOwner.releaseWrite());
  await page.clock.runFor(100);
  expect(await other.evaluate(() => window.__passwordOwner.storedUser())).toBe(ids.b);
  expect(await page.evaluate(() => window.__passwordOwner.errors())).toEqual([]);
});

test('a partially rejected chunk cleanup cannot claim successful adoption or restore prior bytes', async ({ context, page }) => {
  await install(context); await load(page);
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session('b', 10000))).toString('base64url');
  const chunks = [];
  for (let index = 0; index * 2500 < encoded.length; index++) chunks.push({ name: key + '.' + index, value: encoded.slice(index * 2500, (index + 1) * 2500), url: origin });
  await context.addCookies(chunks);
  await page.evaluate(rejected => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => descriptor.get!.call(document),
      set: value => { if (!String(value).startsWith(rejected + '=')) descriptor.set!.call(document, value); } });
  }, key + '.0');
  expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: false, current: false });
  const cookies = await context.cookies(origin);
  // Cookie APIs offer no atomic multi-cookie transaction. Keep this limitation
  // explicit: rejection is reported; no unsafe restoration is attempted.
  expect(cookies.find(cookie => cookie.name === key + '.0')?.value).toBe(chunks[0].value);
  expect(cookies.some(cookie => cookie.name === key)).toBe(true);
});

test('the receipt remains current after a valid rotation of the same provider session', async ({ context, page }) => {
  await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: true, current: true });
  const cookie = (await context.cookies(origin)).find(item => item.name === key)!;
  const value = JSON.parse(Buffer.from(cookie.value.slice(7), 'base64url').toString());
  const claims = JSON.parse(Buffer.from(value.access_token.split('.')[1], 'base64url').toString());
  value.access_token = [value.access_token.split('.')[0], Buffer.from(JSON.stringify({ ...claims, rotation: 1 })).toString('base64url'), 'synthetic-rotated-signature'].join('.');
  value.refresh_token = 'a-synthetic-rotated-refresh';
  cookie.value = 'base64-' + Buffer.from(JSON.stringify(value)).toString('base64url');
  await context.addCookies([cookie]);
  expect(await page.evaluate(() => window.__passwordOwner.lastCurrent())).toBe(true);
});

for (const mismatch of ['user', 'session'] as const) {
  test('an expired token pair cannot adopt a refreshed ' + mismatch + ' that differs from its supplied access token', async ({ context, page }) => {
    const control = await install(context); await load(page);
    await page.evaluate(() => window.__passwordOwner.sharedSignIn('b'));
    const before = await page.evaluate(() => window.__passwordOwner.snapshot());
    const signingIn = page.evaluate(() => window.__passwordOwner.tokenSignIn());
    await expect.poll(() => page.evaluate(() => window.__passwordOwner.tokensPending())).toBe(true);
    if (mismatch === 'session') control.mode('different-session');
    const tokens = session('a', 0, true);
    if (mismatch === 'user') tokens.refresh_token = session('b').refresh_token;
    await page.evaluate(tokens => window.__passwordOwner.releaseTokens(tokens), tokens);
    expect(await signingIn).toMatchObject({ ok: false, current: false });
    expect(control.requests).toEqual(['/auth/v1/token?grant_type=password', '/auth/v1/token?grant_type=refresh_token']);
    expectOnlyNewSessionReservation(before, await page.evaluate(() => window.__passwordOwner.snapshot()));
  });
}

test('a matching expired token pair renews and adopts its original user and session', async ({ context, page }) => {
  const control = await install(context); await load(page);
  await page.evaluate(() => window.__passwordOwner.sharedSignIn('b'));
  const signingIn = page.evaluate(() => window.__passwordOwner.tokenSignIn());
  await expect.poll(() => page.evaluate(() => window.__passwordOwner.tokensPending())).toBe(true);
  await page.evaluate(tokens => window.__passwordOwner.releaseTokens(tokens), session('a', 0, true));
  expect(await signingIn).toMatchObject({ ok: true, user: ids.a, current: true });
  expect(control.requests).toEqual(['/auth/v1/token?grant_type=password', '/auth/v1/token?grant_type=refresh_token']);
  expect(await page.evaluate(() => window.__passwordOwner.storedUser())).toBe(ids.a);
});

test('an old singleton refresh cannot overwrite a newer deliberate login without an intervening logout', async ({ context, page }) => {
  const control = await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: true, user: ids.a });
  control.hold();
  const renewing = page.evaluate(() => window.__passwordOwner.refresh());
  await expect.poll(() => control.requests.filter(request => request.includes('refresh_token')).length).toBe(1);
  const other = await context.newPage(); await load(other);
  expect(await other.evaluate(() => window.__passwordOwner.signIn('b'))).toMatchObject({ ok: true, user: ids.b });
  const before = await other.evaluate(() => window.__passwordOwner.snapshot());
  control.release();
  await renewing;
  expect(await other.evaluate(() => window.__passwordOwner.snapshot())).toEqual(before);
});

test('the final singleton refresh write cannot overwrite a newer deliberate login without logout', async ({ context, page }) => {
  await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn())).toMatchObject({ ok: true, user: ids.a });
  await page.evaluate(() => window.__passwordOwner.pauseRefreshWrite());
  const renewing = page.evaluate(() => window.__passwordOwner.refresh());
  await expect.poll(() => page.evaluate(() => window.__passwordOwner.refreshWritePaused())).toBe(true);
  const other = await context.newPage(); await load(other);
  expect(await other.evaluate(() => window.__passwordOwner.signIn('b'))).toMatchObject({ ok: true, user: ids.b });
  const before = await other.evaluate(() => window.__passwordOwner.snapshot());
  await page.evaluate(() => window.__passwordOwner.releaseRefreshWrite());
  await renewing;
  expect(await other.evaluate(() => window.__passwordOwner.snapshot())).toEqual(before);
});

async function prepareCallback(context: BrowserContext, page: Page) {
  await install(context); await load(page);
  await context.addCookies([{ name: key + '-code-verifier', value: 'synthetic-callback-verifier', url: origin }]);
  await captureInitiatedCallback(context, page);
}

/** Mint only at the initiating decision, before any tested retirement or replacement. */
async function seedInitiation(context: BrowserContext, nonce = initiationNonce, kind: PkceInitiationKind = 'oauth') {
  const original = await requestWitness(context);
  const raw = encodePkceInitiationRecord({ ...original, nonce, kind });
  await context.addCookies([{ name: initiationKey, value: raw, url: origin }]);
  return raw;
}

async function captureInitiatedCallback(context: BrowserContext, page: Page) {
  await seedInitiation(context);
  expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
  const admission = await requestWitness(context);
  expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(true);
  expect(await page.evaluate(() => window.__passwordOwner.initiationCurrent())).toBe(true);
}

test('callback fingerprint is canonical and verified adoption consumes only its matching verifier', async ({ context, page }) => {
  await prepareCallback(context, page);
  await context.addCookies([{ name: 'sb-other-auth-token-code-verifier', value: 'other-pending', url: origin }]);
  const fingerprint = await page.evaluate(() => window.__passwordOwner.callbackFingerprint());
  const { createHash } = await import('node:crypto');
  expect(fingerprint).toBe(createHash('sha256').update(JSON.stringify([{ name: key + '-code-verifier', value: 'synthetic-callback-verifier' }])).digest('hex'));
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: true, user: ids.a });
  expect(await page.evaluate(() => window.__passwordOwner.adoptedCallbackCurrent())).toBe(true);
  const cookies = await context.cookies(origin);
  expect(cookies.some(cookie => cookie.name === key + '-code-verifier' || cookie.name === initiationKey)).toBe(false);
  expect(cookies.find(cookie => cookie.name === 'sb-other-auth-token-code-verifier')?.value).toBe('other-pending');
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
});

for (const change of ['logout', 'new-session', 'new-verifier', 'retired-ui', 'deadline'] as const) {
  test('callback receipt cannot adopt after ' + change + ' while the server exchange was pending', async ({ context, page }) => {
    if (change === 'deadline') await page.clock.install();
    await prepareCallback(context, page);
    if (change === 'logout') await page.evaluate(() => window.__passwordOwner.clear());
    if (change === 'new-session') await page.evaluate(() => window.__passwordOwner.signIn('b'));
    if (change === 'new-verifier') await context.addCookies([{ name: key + '-code-verifier', value: 'newer-verifier', url: origin }]);
    if (change === 'retired-ui') await page.evaluate(() => window.__passwordOwner.retire());
    if (change === 'deadline') await page.clock.runFor(60_001);
    const before = await context.cookies(origin);
    expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
    expect(await context.cookies(origin)).toEqual(before);
    expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
  });
}

for (const change of ['generation-only', 'new-session', 'new-verifier', 'new-record', 'retired-ui', 'deadline'] as const) {
  test('callback final SDK write refuses ' + change + ' without restoring or consuming cookie bytes', async ({ context, page }) => {
    if (change === 'deadline') await page.clock.install();
    await prepareCallback(context, page);
    await page.evaluate(() => window.__passwordOwner.pauseWrite());
    const installing = page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'));
    await expect.poll(() => page.evaluate(() => window.__passwordOwner.writePaused())).toBe(true);
    if (change === 'generation-only') await context.addCookies([{ name: key + '-logout-generation', value: 'explicit-logout', url: origin }]);
    if (change === 'new-session') { const other = await context.newPage(); await load(other); await other.evaluate(() => window.__passwordOwner.signIn('b')); }
    if (change === 'new-verifier') await context.addCookies([{ name: key + '-code-verifier', value: 'newer-verifier', url: origin }]);
    if (change === 'new-record') await seedInitiation(context, 'f'.repeat(32));
    if (change === 'retired-ui') await page.evaluate(() => window.__passwordOwner.retire());
    if (change === 'deadline') await page.clock.runFor(20_001);
    const before = await context.cookies(origin);
    await page.evaluate(() => window.__passwordOwner.releaseWrite());
    expect(await installing).toMatchObject({ ok: false });
    expect(await context.cookies(origin)).toEqual(before);
  });
}

test('callback owner accepts ordinary rotation of the same original session and cleans old chunks', async ({ context, page }) => {
  await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn('b'))).toMatchObject({ ok: true });
  await context.addCookies([{ name: key + '-code-verifier.0', value: 'synthetic-', url: origin },
    { name: key + '-code-verifier.1', value: 'chunked-verifier', url: origin }]);
  await captureInitiatedCallback(context, page);
  const cookie = (await context.cookies(origin)).find(item => item.name === key)!;
  const value = JSON.parse(Buffer.from(cookie.value.slice(7), 'base64url').toString());
  const claims = JSON.parse(Buffer.from(value.access_token.split('.')[1], 'base64url').toString());
  value.access_token = [value.access_token.split('.')[0], Buffer.from(JSON.stringify({ ...claims, rotation: 2 })).toString('base64url'), 'rotated-signature'].join('.');
  value.refresh_token = 'b-rotated-refresh';
  cookie.value = 'base64-' + Buffer.from(JSON.stringify(value)).toString('base64url');
  await context.addCookies([cookie]);
  expect(await page.evaluate(() => window.__passwordOwner.callbackCurrent())).toBe(true);
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: true, user: ids.a });
  expect((await context.cookies(origin)).some(item => item.name.startsWith(key + '-code-verifier'))).toBe(false);
});

for (const change of ['new-verifier', 'generation-only', 'new-session'] as const) {
  test('post-adoption callback navigation guard refuses ' + change, async ({ context, page }) => {
    await prepareCallback(context, page);
    expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: true });
    if (change === 'new-verifier') await context.addCookies([{ name: key + '-code-verifier', value: 'newer-verifier', url: origin }]);
    if (change === 'generation-only') await context.addCookies([{ name: key + '-logout-generation', value: 'explicit-logout', url: origin }]);
    if (change === 'new-session') await page.evaluate(() => window.__passwordOwner.signIn('b'));
    expect(await page.evaluate(() => window.__passwordOwner.adoptedCallbackCurrent())).toBe(false);
  });
}

test('failed verifier consumption cannot claim callback completion or restore retired session bytes', async ({ context, page }) => {
  await prepareCallback(context, page);
  await page.evaluate(verifier => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => descriptor.get!.call(document),
      set: value => { if (!String(value).startsWith(verifier + '=')) descriptor.set!.call(document, value); } });
  }, key + '-code-verifier');
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__passwordOwner.storedUser())).toBe(ids.a);
  expect(await page.evaluate(() => window.__passwordOwner.adoptedCallbackCurrent())).toBe(false);
  expect((await context.cookies(origin)).find(cookie => cookie.name === key + '-code-verifier')?.value).toBe('synthetic-callback-verifier');
});

test('callback provider rejection retains the original session and verifier', async ({ context, page }) => {
  const control = await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn('b'))).toMatchObject({ ok: true });
  await context.addCookies([{ name: key + '-code-verifier', value: 'pending-verifier', url: origin }]);
  await captureInitiatedCallback(context, page);
  const before = await context.cookies(origin);
  control.mode('reject');
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
  expect(await context.cookies(origin)).toEqual(before);
});

for (const method of ['getUser', 'getSession'] as const) {
  test('no-code ' + method + ' fallback cannot overwrite B when expired A renewal reaches its final write', async ({ context, page }) => {
    await install(context); await load(page);
    const stored = session('a', 0, true);
    await context.addCookies([{ name: key, value: 'base64-' + Buffer.from(JSON.stringify(stored)).toString('base64url'), url: origin }]);
    expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
    await page.evaluate(() => window.__passwordOwner.pauseRefreshWrite());
    const reading = page.evaluate(method => window.__passwordOwner.fallbackRead(method), method);
    await expect.poll(() => page.evaluate(() => window.__passwordOwner.refreshWritePaused())).toBe(true);
    const other = await context.newPage(); await load(other);
    expect(await other.evaluate(() => window.__passwordOwner.signIn('b'))).toMatchObject({ ok: true, user: ids.b });
    const before = await other.evaluate(() => window.__passwordOwner.snapshot());
    await page.evaluate(() => window.__passwordOwner.releaseRefreshWrite());
    const result = await reading;
    expect(result.ownerCurrent).toBe(false);
    expect(result.user).not.toBe(ids.a);
    expect(await other.evaluate(() => window.__passwordOwner.snapshot())).toEqual(before);
  });

  test('no-code ' + method + ' fallback permits renewal of the same expired session', async ({ context, page }) => {
    await install(context); await load(page);
    const stored = session('a', 0, true);
    await context.addCookies([{ name: key, value: 'base64-' + Buffer.from(JSON.stringify(stored)).toString('base64url'), url: origin }]);
    expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
    expect(await page.evaluate(method => window.__passwordOwner.fallbackRead(method), method)).toMatchObject({ user: ids.a, ownerCurrent: true });
    expect(await page.evaluate(() => window.__passwordOwner.storedUser())).toBe(ids.a);
  });
}

test('partial callback chunk cleanup loses ownership and cannot retry installation', async ({ context, page }) => {
  await install(context); await load(page);
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session('b', 10000))).toString('base64url');
  const chunks = [];
  for (let index = 0; index * 2500 < encoded.length; index++) chunks.push({ name: key + '.' + index, value: encoded.slice(index * 2500, (index + 1) * 2500), url: origin });
  await context.addCookies([...chunks, { name: key + '-code-verifier', value: 'pending-verifier', url: origin }]);
  await captureInitiatedCallback(context, page);
  await page.evaluate(rejected => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => descriptor.get!.call(document),
      set: value => { if (!String(value).startsWith(rejected + '=')) descriptor.set!.call(document, value); } });
  }, key + '.0');
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
  const after = await context.cookies(origin);
  expect(after.find(cookie => cookie.name === key + '-code-verifier')?.value).toBe('pending-verifier');
  expect(await page.evaluate(() => window.__passwordOwner.callbackCurrent())).toBe(false);
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(1);
  expect(await context.cookies(origin)).toEqual(after);
});

test('unchanged malformed session bytes remain a comparison boundary, not an authenticated identity', async ({ context, page }) => {
  await prepareCallback(context, page);
  await context.addCookies([{ name: key, value: 'malformed-session', url: origin }]);
  expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
  expect(await page.evaluate(() => window.__passwordOwner.storedUser())).toBeNull();
  expect(await page.evaluate(() => window.__passwordOwner.callbackCurrent())).toBe(true);
  await context.addCookies([{ name: key, value: 'different-malformed-session', url: origin }]);
  expect(await page.evaluate(() => window.__passwordOwner.callbackCurrent())).toBe(false);
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
});

test('callback owner rejects a newer login of the same user with a different session identifier', async ({ context, page }) => {
  await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn('b'))).toMatchObject({ ok: true });
  await context.addCookies([{ name: key + '-code-verifier', value: 'pending-verifier', url: origin }]);
  await captureInitiatedCallback(context, page);
  const cookie = (await context.cookies(origin)).find(item => item.name === key)!;
  const value = JSON.parse(Buffer.from(cookie.value.slice(7), 'base64url').toString());
  const claims = JSON.parse(Buffer.from(value.access_token.split('.')[1], 'base64url').toString());
  value.access_token = [value.access_token.split('.')[0], Buffer.from(JSON.stringify({ ...claims, session_id: '33333333-3333-4333-8333-333333333333' })).toString('base64url'), 'new-session-signature'].join('.');
  cookie.value = 'base64-' + Buffer.from(JSON.stringify(value)).toString('base64url');
  await context.addCookies([cookie]);
  const before = await context.cookies(origin);
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
  expect(await context.cookies(origin)).toEqual(before);
});

for (const layout of ['missing', 'overlap', 'gap', 'empty'] as const) {
  test('callback rejects ' + layout + ' verifier layout before token installation', async ({ context, page }) => {
    await install(context); await load(page);
    if (layout === 'overlap') await context.addCookies([{ name: key + '-code-verifier', value: 'whole', url: origin }, { name: key + '-code-verifier.0', value: 'chunk', url: origin }]);
    if (layout === 'gap') await context.addCookies([{ name: key + '-code-verifier.1', value: 'chunk', url: origin }]);
    if (layout === 'empty') await context.addCookies([{ name: key + '-code-verifier', value: '', url: origin }]);
    expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(layout === 'missing');
    expect(await page.evaluate(() => window.__passwordOwner.callbackFingerprint())).toBeNull();
    expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
    expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
  });
}

async function requestWitness(context: BrowserContext): Promise<CallbackAdmissionWitness> {
  const material = callbackAdmissionMaterial((await context.cookies(origin)).map(({ name, value }) => ({ name, value })), key);
  if (!material) throw new Error('Invalid synthetic admission state');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  return { v: 1, project: hash(material.project), generation: hash(material.generation), verifier: hash(material.verifier), session: hash(material.session) };
}

for (const change of ['logout-refused-verifier-deletion', 'newer-login'] as const) {
  test('held admission response cannot adopt after ' + change + ' before completion captures its owner', async ({ context, page }) => {
    await prepareCallback(context, page);
    const admission = await requestWitness(context);
    if (change === 'logout-refused-verifier-deletion') {
      expect(await page.evaluate(() => window.__passwordOwner.clearRefusingVerifier())).toBe(false);
      expect((await context.cookies(origin)).some(cookie => cookie.name === key + '-logout-generation')).toBe(true);
    } else expect(await page.evaluate(() => window.__passwordOwner.signIn('b'))).toMatchObject({ ok: true, user: ids.b });
    // The completion document only mounts now, after the request-time browser
    // state changed. A fresh local snapshot alone cannot detect this boundary.
    expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
    const before = await context.cookies(origin);
    expect(before.find(cookie => cookie.name === key + '-code-verifier')?.value).toBe('synthetic-callback-verifier');
    expect(await page.evaluate(({ tokens, admission }) => window.__passwordOwner.adoptAfterAdmission(tokens, admission), { tokens: session('a'), admission })).toMatchObject({ ok: false });
    expect(await context.cookies(origin)).toEqual(before);
    expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
  });
}

test('request-time admission accepts actual same-session renewal before completion mounts', async ({ context, page }) => {
  await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn('a'))).toMatchObject({ ok: true });
  await context.addCookies([{ name: key + '-code-verifier', value: 'synthetic-callback-verifier', url: origin }]);
  await captureInitiatedCallback(context, page);
  const admission = await requestWitness(context);
  expect(await page.evaluate(() => window.__passwordOwner.refresh())).toMatchObject({ ok: true, user: ids.a });
  expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
  expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(true);
  expect(await page.evaluate(({ tokens, admission }) => window.__passwordOwner.adoptAfterAdmission(tokens, admission), { tokens: session('a'), admission })).toMatchObject({ ok: true, user: ids.a });
});

test('request-time admission includes empty no-code fallback state and its later logout generation', async ({ context, page }) => {
  await install(context); await load(page);
  const admission = await requestWitness(context);
  expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
  expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(true);
  expect(await page.evaluate(() => window.__passwordOwner.clear())).toBe(true);
  expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
  expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(false);
});

for (const layout of ['malformed', 'overlapping-chunks', 'legacy-without-session-id'] as const) {
  test('request-time admission uses exact cookie ownership for ' + layout, async ({ context, page }) => {
    await prepareCallback(context, page);
    const original = session('a');
    if (layout === 'legacy-without-session-id') {
      const parts = original.access_token.split('.');
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      delete claims.session_id;
      parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
      original.access_token = parts.join('.');
    }
    const value = layout === 'malformed' ? 'malformed-session' : 'base64-' + Buffer.from(JSON.stringify(original)).toString('base64url');
    await context.addCookies([{ name: key, value, url: origin },
      ...(layout === 'overlapping-chunks' ? [{ name: key + '.0', value: 'stale-chunk', url: origin }] : [])]);
    const admission = await requestWitness(context);
    expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
    expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(true);
    await context.addCookies([{ name: key, value: value + 'changed', url: origin }]);
    expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
    expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(false);
  });
}

for (const field of ['project', 'generation', 'verifier', 'session'] as const) {
  test('request-time admission refuses a different ' + field + ' digest', async ({ context, page }) => {
    await prepareCallback(context, page);
    const admission = await requestWitness(context);
    expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), { ...admission, [field]: '0'.repeat(64) })).toBe(false);
    expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
  });
}

for (const change of ['logout', 'newer-login', 'newer-verifier', 'deadline'] as const) {
  test('request-time admission rechecks ' + change + ' after asynchronous hashing', async ({ context, page }) => {
    if (change === 'deadline') await page.clock.install();
    await prepareCallback(context, page);
    const admission = await requestWitness(context);
    await page.evaluate(() => window.__passwordOwner.pauseDigest());
    const checking = page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission);
    await expect.poll(() => page.evaluate(() => window.__passwordOwner.digestPaused())).toBe(true);
    if (change === 'logout') expect(await page.evaluate(() => window.__passwordOwner.clear())).toBe(true);
    if (change === 'newer-login') expect(await page.evaluate(() => window.__passwordOwner.signIn('b'))).toMatchObject({ ok: true });
    if (change === 'newer-verifier') await context.addCookies([{ name: key + '-code-verifier', value: 'newer-verifier', url: origin }]);
    if (change === 'deadline') await page.clock.runFor(60_001);
    const before = await context.cookies(origin);
    await page.evaluate(() => window.__passwordOwner.releaseDigest());
    expect(await checking).toBe(false);
    expect(await context.cookies(origin)).toEqual(before);
  });
}

test('request-time admission ignores other projects and accepts canonical verifier chunks', async ({ context, page }) => {
  await install(context); await load(page);
  await context.addCookies([{ name: key + '-code-verifier.0', value: 'first-', url: origin },
    { name: key + '-code-verifier.1', value: 'second', url: origin }]);
  const admission = await requestWitness(context);
  await context.addCookies([{ name: 'sb-other-auth-token', value: 'other-login', url: origin },
    { name: 'sb-other-auth-token-code-verifier', value: 'other-verifier', url: origin },
    { name: 'sb-other-auth-token-logout-generation', value: 'other-logout', url: origin }]);
  expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
  expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(true);
});

test('original initiation rejects a callback first requested after logout when verifier and record deletion were refused', async ({ context, page }) => {
  await prepareCallback(context, page);
  const original = (await context.cookies(origin)).find(cookie => cookie.name === initiationKey)!.value;
  expect(await page.evaluate(() => window.__passwordOwner.clearRefusingVerifier())).toBe(false);
  // The new request witness agrees with logout state, but the original initiation
  // record must still identify this retained verifier as belonging to an old decision.
  const admission = await requestWitness(context);
  expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
  expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(true);
  expect(await page.evaluate(() => window.__passwordOwner.initiationCurrent())).toBe(false);
  const before = await context.cookies(origin);
  expect(before.find(cookie => cookie.name === initiationKey)?.value).toBe(original);
  expect(await page.evaluate(({ tokens, admission }) => window.__passwordOwner.adoptAfterAdmission(tokens, admission), { tokens: session('a'), admission })).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
  expect(await context.cookies(origin)).toEqual(before);
});

test('original initiation rejects a first callback request after a newer login without logout', async ({ context, page }) => {
  await prepareCallback(context, page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn('b'))).toMatchObject({ ok: true, user: ids.b });
  const admission = await requestWitness(context);
  expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
  expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(true);
  const before = await context.cookies(origin);
  expect(await page.evaluate(({ tokens, admission }) => window.__passwordOwner.adoptAfterAdmission(tokens, admission), { tokens: session('a'), admission })).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
  expect(await context.cookies(origin)).toEqual(before);
});

for (const kind of ['signup', 'oauth', 'recovery'] as const) {
  test('a matching original ' + kind + ' initiation permits verified SDK adoption', async ({ context, page }) => {
    await install(context); await load(page);
    await context.addCookies([{ name: key + '-code-verifier', value: 'synthetic-callback-verifier', url: origin }]);
    await seedInitiation(context, initiationNonce, kind);
    const admission = await requestWitness(context);
    expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
    expect(await page.evaluate(({ tokens, admission, recovery }) => window.__passwordOwner.adoptAfterAdmission(tokens, admission, undefined, recovery),
      { tokens: session('a'), admission, recovery: kind === 'recovery' })).toMatchObject({ ok: true, user: ids.a });
    expect((await context.cookies(origin)).some(cookie => cookie.name === initiationKey || cookie.name === key + '-code-verifier')).toBe(false);
  });
}

for (const invalid of ['missing', 'malformed', 'different-nonce', 'wrong-kind', 'wrong-session-hash', 'wrong-generation-hash'] as const) {
  test('callback rejects ' + invalid + ' initiation despite a matching fresh request witness', async ({ context, page }) => {
    await prepareCallback(context, page);
    const original = parsePkceInitiationRecord((await context.cookies(origin)).find(cookie => cookie.name === initiationKey)!.value)!;
    if (invalid === 'missing') await context.clearCookies({ name: initiationKey });
    else {
      const raw = invalid === 'malformed' ? 'malformed-record' : encodePkceInitiationRecord({ ...original,
        ...(invalid === 'different-nonce' ? { nonce: 'f'.repeat(32) } : {}),
        ...(invalid === 'wrong-kind' ? { kind: 'recovery' as const } : {}),
        ...(invalid === 'wrong-session-hash' ? { session: '0'.repeat(64) } : {}),
        ...(invalid === 'wrong-generation-hash' ? { generation: '0'.repeat(64) } : {}),
      });
      await context.addCookies([{ name: initiationKey, value: raw, url: origin }]);
    }
    const admission = await requestWitness(context);
    expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
    expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(true);
    const before = await context.cookies(origin);
    expect(await page.evaluate(({ tokens, admission }) => window.__passwordOwner.adoptAfterAdmission(tokens, admission), { tokens: session('a'), admission })).toMatchObject({ ok: false });
    expect(await page.evaluate(() => window.__passwordOwner.callbackFingerprint())).toBeNull();
    expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
    expect(await context.cookies(origin)).toEqual(before);
  });
}

test('initiation hashing rejects a replacement record even when the verifier bytes did not change', async ({ context, page }) => {
  await install(context); await load(page);
  await context.addCookies([{ name: key + '-code-verifier', value: 'synthetic-callback-verifier', url: origin }]);
  await seedInitiation(context);
  expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
  const admission = await requestWitness(context);
  expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(true);
  await page.evaluate(() => window.__passwordOwner.pauseDigest());
  const checking = page.evaluate(() => window.__passwordOwner.initiationCurrent());
  await expect.poll(() => page.evaluate(() => window.__passwordOwner.digestPaused())).toBe(true);
  await seedInitiation(context, 'f'.repeat(32));
  const before = await context.cookies(origin);
  await page.evaluate(() => window.__passwordOwner.releaseDigest());
  expect(await checking).toBe(false);
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
  expect(await context.cookies(origin)).toEqual(before);
  expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
});

test('a consumed initiation nonce cannot be replayed by a freshly captured callback owner', async ({ context, page }) => {
  await prepareCallback(context, page);
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: true });
  expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(true);
  const admission = await requestWitness(context), before = await context.cookies(origin);
  expect(await page.evaluate(({ tokens, admission }) => window.__passwordOwner.adoptAfterAdmission(tokens, admission), { tokens: session('a'), admission })).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(1);
  expect(await context.cookies(origin)).toEqual(before);
});

test('refused initiation-record consumption cannot claim completion or retry the installed session', async ({ context, page }) => {
  await prepareCallback(context, page);
  const original = (await context.cookies(origin)).find(cookie => cookie.name === initiationKey)!.value;
  await page.evaluate(name => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => descriptor.get!.call(document),
      set: value => { if (!String(value).startsWith(name + '=')) descriptor.set!.call(document, value); } });
  }, initiationKey);
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__passwordOwner.storedUser())).toBe(ids.a);
  expect(await page.evaluate(() => window.__passwordOwner.adoptedCallbackCurrent())).toBe(false);
  const after = await context.cookies(origin);
  expect(after.find(cookie => cookie.name === initiationKey)?.value).toBe(original);
  expect(after.some(cookie => cookie.name === key + '-code-verifier')).toBe(false);
  expect(await page.evaluate(tokens => window.__passwordOwner.adoptCallback(tokens), session('a'))).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(1);
  expect(await context.cookies(origin)).toEqual(after);
});

test('an old session logout intent preserves a newer initiation nonce with unchanged verifier bytes', async ({ context, page }) => {
  await install(context); await load(page);
  expect(await page.evaluate(() => window.__passwordOwner.signIn('a'))).toMatchObject({ ok: true });
  await context.addCookies([{ name: key + '-code-verifier', value: 'synthetic-callback-verifier', url: origin }]);
  await captureInitiatedCallback(context, page);
  await page.evaluate(() => window.__passwordOwner.captureLogout());
  await seedInitiation(context, 'f'.repeat(32));
  const before = await context.cookies(origin);
  expect(await page.evaluate(() => window.__passwordOwner.clearCaptured())).toBe('session-changed');
  expect(await context.cookies(origin)).toEqual(before);
  expect(await page.evaluate(() => window.__passwordOwner.clear())).toBe(true);
  expect((await context.cookies(origin)).some(cookie => cookie.name === initiationKey || cookie.name === key + '-code-verifier')).toBe(false);
});

for (const family of ['session', 'verifier'] as const) {
  test('request-time admission rejects duplicate ' + family + ' cookies at root and auth paths', async ({ context, page }) => {
    await prepareCallback(context, page);
    const cookieName = family === 'session' ? key : key + '-code-verifier';
    const value = family === 'session' ? 'base64-' + Buffer.from(JSON.stringify(session('a'))).toString('base64url') : 'synthetic-callback-verifier';
    await context.addCookies([{ name: cookieName, value, url: origin }]);
    const admission = await requestWitness(context);
    await context.addCookies([{ name: cookieName, value, domain: new URL(origin).hostname, path: '/auth', secure: true, sameSite: 'Lax' }]);
    await load(page, '/auth/complete');
    expect(await page.evaluate(name => document.cookie.split(';').filter(pair => pair.trim().startsWith(name + '=')).length, cookieName)).toBe(2);
    expect(await page.evaluate(() => window.__passwordOwner.captureCallback())).toBe(false);
    expect(await page.evaluate(witness => window.__passwordOwner.admissionCurrent(witness), admission)).toBe(false);
    expect(await page.evaluate(() => window.__passwordOwner.setSessionCalls())).toBe(0);
  });
}



