import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

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
const browserEntry = collect('lib/supabase/client.ts');
const storageEntry = collect('lib/auth/browser-session-storage.ts');
const cacheEntry = collect('lib/auth/cache-session.ts');
const signalEntry = collect('lib/auth/session-change.ts');
const ssrEntry = collect(require.resolve('@supabase/ssr'));
const origin = 'https://password-ownership-fixture.invalid';
const provider = 'https://password-owner.supabase.co';
const key = 'sb-password-owner-auth-token';
const ids = { a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
type Result = { ok: boolean; user: string | null; current: boolean; error?: string };
type Probe = {
  signIn: (who?: 'a' | 'b') => Promise<Result>; retire: () => void;
  tokenSignIn: () => Promise<Result>; releaseTokens: (tokens: { access_token: string; refresh_token: string }) => void;
  tokensPending: () => boolean; setSessionCalls: () => number; disposedClients: () => number;
  sharedSignIn: (who: 'a' | 'b') => Promise<void>; storedUser: () => string | null;
  snapshot: () => unknown; clear: () => boolean; lastCurrent: () => boolean;
  observe: () => void; cacheUser: () => string | null; signals: () => number;
  pauseWrite: () => void; writePaused: () => boolean; releaseWrite: () => void;
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
async function load(page: Page) {
  await page.goto(origin);
  await page.addScriptTag({ content: sdk });
  const bootstrap = String.raw`function boot({sources,entry,browserEntry,storageEntry,cacheEntry,signalEntry,ssrEntry,provider,key}) {
 const loaded={}; const process={env:{NEXT_PUBLIC_SUPABASE_URL:provider,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key'}};
 let pause=false,paused=false,release,setSessionCalls=0,disposedClients=0;
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
 const helper=load(entry),storage=load(storageEntry),browser=load(browserEntry),cache=load(cacheEntry),signal=load(signalEntry);
 let active=true,last=null,signalCount=0,observing=false,releaseTokens;
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
  storedUser:()=>storage.captureBrowserSessionSnapshot()?.userId??null,snapshot:storage.captureBrowserSessionSnapshot,
  clear:()=>storage.clearBrowserSessionSnapshot(storage.captureBrowserSessionSnapshot()),
  lastCurrent:()=>!!last&&helper.isPasswordSessionCurrent(last),
  observe:()=>{if(observing)return;observing=true;signal.subscribeSessionStorageChanges(()=>{signalCount++;});cache.subscribeCacheSession(()=>{});browser.createClient().auth.onAuthStateChange(event=>events.push(event));},
  cacheUser:()=>cache.getCacheSessionSnapshot().identity?.userId??null,signals:()=>signalCount,
  pauseWrite:()=>{pause=true;},writePaused:()=>paused,releaseWrite:()=>{release?.();},
  events:()=>events,errors:()=>errors
 };
}
`;
  await page.addScriptTag({ content: '(' + bootstrap + ')(' + JSON.stringify({ sources: modules, entry, browserEntry, storageEntry, cacheEntry, signalEntry, ssrEntry, provider, key }) + ');' });
}
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

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
    expect(await page.evaluate(() => window.__passwordOwner.snapshot())).toEqual(before);
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
  expect(await page.evaluate(() => window.__passwordOwner.snapshot())).toEqual(before);
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
    expect(await page.evaluate(() => window.__passwordOwner.snapshot())).toEqual(before);
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



