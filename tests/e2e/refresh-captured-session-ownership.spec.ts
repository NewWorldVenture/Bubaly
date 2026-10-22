import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { Session } from '@supabase/supabase-js';
import type { BrowserSessionSnapshot } from '../../lib/auth/browser-session-storage';

// Real production factory, public SSR cookie adapter and installed auth SDK.
// Provider responses and explicitly labelled scheduling barriers are controlled.
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
const entry = collect('lib/supabase/client.ts');
const storageEntry = collect('lib/auth/browser-session-storage.ts');
const passwordEntry = collect('lib/auth/password-client.ts');
const origin = 'https://logout-storage-fixture.invalid';
const provider = 'https://logout-storage.supabase.co';
const key = 'sb-logout-storage-auth-token';
const ids = { a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
type CapturedRefreshProbe = {
  signIn: (who: 'a' | 'b') => Promise<void>;
  snapshot: (includePending?: boolean) => BrowserSessionSnapshot | null;
  clear: (snapshot: BrowserSessionSnapshot | null) => boolean;
  refresh: () => Promise<string | null>;
  user: () => Promise<string | null>;
  pauseWrite: () => void;
  writePaused: () => boolean;
  releaseWrite: () => void;
  pauseErrorBody: () => void;
  errorBodyPaused: () => boolean;
  releaseErrorBody: () => void;
  pauseDelete: () => void;
  deletePaused: () => boolean;
  releaseDelete: () => void;
  sdkSignOut: () => Promise<string | null>;
  startConcurrentRefresh: () => void;
  concurrentRefreshResult: () => string | null;
  events: () => string[];
  capture: () => Promise<Session>;
  verifiedUser: () => Promise<string|null>;
  refreshGiven: (session:Session) => Promise<string|null>;
};
declare global { interface Window { __capturedRefreshOwner: CapturedRefreshProbe } }
type Mode = 'normal' | 'incomplete' | 'unavailable' | 'rejected';

async function install(context: BrowserContext, large = false) {
  let mode: Mode = 'normal';
  let release: (() => void) | undefined;
  let hold: Promise<void> | undefined;
  let seenRefresh = 0;
  let revision = 0;
  const sessionForRefresh=new Map<string,string>();
  const control = {
    mode: (value: Mode) => { mode = value; },
    hold: () => { hold = new Promise<void>(resolve => { release = resolve; }); },
    release: () => { release?.(); hold = undefined; },
    calls: () => seenRefresh,
  };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Logout storage fixture</body></html>' }); return;
    }
    if (url.origin !== provider) throw new Error(`Unexpected fixture origin: ${url.origin}`);
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/auth/v1/logout') { await route.fulfill({ headers, status: 204 }); return; }
    if (url.pathname === '/auth/v1/user') {
      const token=route.request().headers().authorization?.replace(/^Bearer /,'')??'';
      const sub=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub;
      await route.fulfill({headers,contentType:'application/json',body:JSON.stringify({id:sub,aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-09-12T00:00:00Z'})});return;
    }
    if (url.pathname !== '/auth/v1/token') throw new Error(`Unexpected fixture request: ${url.pathname}`);
    const body = route.request().postDataJSON() as { email?: string; refresh_token?: string };
    const who = (body.email?.startsWith('b@') || body.refresh_token?.startsWith('b-')) ? 'b' : 'a';
    if (url.searchParams.get('grant_type') === 'refresh_token') {
      seenRefresh++;
      if (hold) await hold;
      if (mode !== 'normal') {
        await route.fulfill({ headers, status: mode === 'unavailable' ? 503 : mode === 'rejected' ? 400 : 200,
          contentType: 'application/json', body: mode === 'incomplete' ? '{}' : JSON.stringify({ error_code: 'refresh_token_not_found', message: 'Synthetic renewal failure' }) }); return;
      }
    }
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const sessionId=body.refresh_token ? sessionForRefresh.get(body.refresh_token) : `${who}-session-${revision+1}`;
    const jwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: ids[who], session_id: sessionId, exp: expires, revision: ++revision })).toString('base64url'),
      'synthetic-signature',
    ].join('.');
    const user = { id: ids[who], email: `${who}@fixture.invalid`, aud: 'authenticated', role: 'authenticated', app_metadata: {},
      user_metadata: large ? { fixture: 'x'.repeat(20000) } : {}, created_at: '2026-09-12T00:00:00Z' };
    sessionForRefresh.set(`${who}-refresh-${revision}`,sessionId!);
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ access_token: jwt,
      refresh_token: `${who}-refresh-${revision}`, token_type: 'bearer', expires_at: expires, expires_in: 3600, user }) });
  });
  return control;
}

async function load(page: Page) {
  await page.goto(origin);
  await page.addScriptTag({ content: sdk });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, loaded = {};
    const process = { env: { NEXT_PUBLIC_SUPABASE_URL: ${JSON.stringify(provider)}, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-anon-fixture' } };
    function load(id) {
      if (id === 'sdk') return window.supabase;
      if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module: ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', 'process', item.source)(name => load(item.imports[name]), module, module.exports, process);
      return module.exports;
    }
    const storage = load(${JSON.stringify(storageEntry)});
    let pause = false, paused = false, release;
    let pauseErrorBody = false, errorBodyPaused = false, releaseErrorBody;
    let pauseDelete = false, deletePaused = false, releaseDelete;
    let concurrentRefreshResult = 'pending';
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (pauseErrorBody && !response.ok) {
        pauseErrorBody = false;
        return new Response(new ReadableStream({ start(controller) {
          errorBodyPaused = true;
          releaseErrorBody = async () => { controller.enqueue(new TextEncoder().encode(await response.text())); controller.close(); };
        }}), { status: response.status, headers: response.headers });
      }
      return response;
    };
    const makeStorage = storage.createBrowserSessionStorage;
    storage.createBrowserSessionStorage = url => {
      const adapter = makeStorage(url), write = adapter.cookies.setAll;
      adapter.cookies.setAll = async cookies => {
        if (pauseDelete && cookies.some(cookie => cookie.name === ${JSON.stringify(key)} && cookie.options.maxAge === 0)
          && cookies.every(cookie => cookie.options.maxAge === 0)) {
          pauseDelete = false; deletePaused = true;
          await new Promise(resolve => { releaseDelete = resolve; });
        }
        if (pause && cookies.some(cookie => cookie.name === ${JSON.stringify(key)} && cookie.options.maxAge !== 0)) {
          pause = false; paused = true;
          await new Promise(resolve => { release = resolve; });
        }
        return write(cookies);
      };
      return adapter;
    };
    const client = load(${JSON.stringify(entry)}).createClient();
    const events = [];
    client.auth.onAuthStateChange(event => { events.push(event); });
    window.__capturedRefreshOwner = {
      signIn: async who => { const result = await load(${JSON.stringify(passwordEntry)}).signInWithOwnedSession({ email: who + '@fixture.invalid', password: 'synthetic-password' }, () => true); if (result.error) throw result.error; },
      verifiedUser: async () => { const result=await client.auth.getUser(); if(result.error)throw result.error;return result.data.user?.id??null; },
      capture: async () => { const result=await client.auth.getSession(); if(result.error||!result.data.session)throw new Error('Synthetic expected current session'); return result.data.session; },
      refreshGiven: async session => { try { const result=await client.auth.refreshSession(session); return result.error?.name??null; } catch(error){ return error.name; } },
      snapshot: storage.captureBrowserSessionSnapshot,
      clear: storage.clearBrowserSessionSnapshot,
      refresh: async () => { try { const result = await client.auth.refreshSession(); return result.error?.name ?? null; } catch (error) { return error.name; } },
      user: async () => { const result = await client.auth.getSession(); return result.data.session?.user.id ?? null; },
      pauseWrite: () => { pause = true; }, writePaused: () => paused, releaseWrite: () => { release?.(); }, events: () => events,
      pauseErrorBody: () => { pauseErrorBody = true; }, errorBodyPaused: () => errorBodyPaused,
      releaseErrorBody: () => { return releaseErrorBody?.(); },
      pauseDelete: () => { pauseDelete = true; }, deletePaused: () => deletePaused, releaseDelete: () => { releaseDelete?.(); },
      sdkSignOut: async () => { try { const result = await client.auth.signOut({ scope: 'local' }); return result.error?.name ?? null; } catch (error) { return error.name; } },
      startConcurrentRefresh: () => { concurrentRefreshResult = 'pending'; void window.__capturedRefreshOwner.refresh().then(result => { concurrentRefreshResult = result; }); },
      concurrentRefreshResult: () => concurrentRefreshResult,
    };
  })();` });
  await page.evaluate(() => window.__capturedRefreshOwner.user());
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });


for (const who of ['a','b'] as const) test('a captured refresh cannot replace a later '+(who==='a'?'same-user session':'different user')+' without logout',async({context,page})=>{
  const control=await install(context);await load(page);await page.evaluate(()=>window.__capturedRefreshOwner.signIn('a'));
  const old=await page.evaluate(()=>window.__capturedRefreshOwner.capture());
  const peer=await context.newPage();await load(peer);await peer.evaluate(value=>window.__capturedRefreshOwner.signIn(value),who);
  const newer=await peer.evaluate(()=>window.__capturedRefreshOwner.capture());
  expect(newer.refresh_token).not.toBe(old.refresh_token);
  const before=await context.cookies(origin);
  expect(before.some(cookie=>cookie.name===key+'-logout-generation')).toBe(false);
  const calls=control.calls();
  await page.clock.install();const stale=page.evaluate(value=>window.__capturedRefreshOwner.refreshGiven(value),old);await page.clock.runFor(40_000);const outcome=await stale;
  const after=await peer.evaluate(()=>window.__capturedRefreshOwner.capture());
  await test.info().attach('synthetic-ownership-sequence',{body:JSON.stringify({initialUser:old.user.id,initialToken:old.refresh_token,currentUser:newer.user.id,currentToken:newer.refresh_token,oldSession:JSON.parse(Buffer.from(old.access_token.split('.')[1],'base64url').toString()).session_id,newSession:JSON.parse(Buffer.from(newer.access_token.split('.')[1],'base64url').toString()).session_id,outcome,providerDispatches:control.calls()-calls,finalUser:after.user.id,finalToken:after.refresh_token,cookiesUnchanged:JSON.stringify(await context.cookies(origin))===JSON.stringify(before)}),contentType:'application/json'});
  expect(outcome).toBe('AuthRetryableFetchError');
  expect(control.calls()).toBe(calls);
  expect(await context.cookies(origin)).toEqual(before);
  expect(await peer.evaluate(()=>window.__capturedRefreshOwner.capture())).toEqual(newer);
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.verifiedUser())).toBe(newer.user.id);
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.events())).not.toContain('SIGNED_OUT');
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.refresh())).toBeNull();
  expect(control.calls()).toBe(calls+1);
  expect((await page.evaluate(()=>window.__capturedRefreshOwner.capture())).user.id).toBe(newer.user.id);
});
test('a captured token from the current session still renews and a fresh logout remains available',async({context,page})=>{
  const control=await install(context);await load(page);await page.evaluate(()=>window.__capturedRefreshOwner.signIn('a'));
  const current=await page.evaluate(()=>window.__capturedRefreshOwner.capture());
  expect(await page.evaluate(value=>window.__capturedRefreshOwner.refreshGiven(value),current)).toBeNull();
  expect(control.calls()).toBe(1);
  const next=await page.evaluate(()=>window.__capturedRefreshOwner.capture());
  expect(next.user.id).toBe(current.user.id);expect(next.access_token).not.toBe(current.access_token);
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.clear(window.__capturedRefreshOwner.snapshot()))).toBe(true);
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.snapshot())).toBeNull();
});
test('a stale captured token remains refused when large current cookies are chunked',async({context,page})=>{
  const control=await install(context,true);await load(page);await page.evaluate(()=>window.__capturedRefreshOwner.signIn('a'));
  const old=await page.evaluate(()=>window.__capturedRefreshOwner.capture());
  await page.evaluate(()=>window.__capturedRefreshOwner.signIn('b'));
  const before=await context.cookies(origin);
  expect(before.filter(cookie=>/^sb-logout-storage-auth-token\.\d+$/.test(cookie.name)).length).toBeGreaterThan(7);
  await page.clock.install();const stale=page.evaluate(value=>window.__capturedRefreshOwner.refreshGiven(value),old);await page.clock.runFor(40_000);const outcome=await stale;
  await test.info().attach('synthetic-ownership-sequence',{body:JSON.stringify({initialUser:old.user.id,initialToken:old.refresh_token,outcome,providerDispatches:control.calls(),finalUser:(await page.evaluate(()=>window.__capturedRefreshOwner.capture())).user.id,cookiesUnchanged:JSON.stringify(await context.cookies(origin))===JSON.stringify(before)}),contentType:'application/json'});
  expect(outcome).toBe('AuthRetryableFetchError');
  expect(control.calls()).toBe(0);expect(await context.cookies(origin)).toEqual(before);
});
test('a genuine pending current renewal completes without retiring its owner',async({context,page})=>{
  const control=await install(context);await load(page);await page.evaluate(()=>window.__capturedRefreshOwner.signIn('a'));
  const old=await page.evaluate(()=>window.__capturedRefreshOwner.capture());control.hold();
  const pending=page.evaluate(value=>window.__capturedRefreshOwner.refreshGiven(value),old);
  await expect.poll(()=>control.calls()).toBe(1);
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.snapshot()?.accessToken)).toBe(old.access_token);
  control.release();expect(await pending).toBeNull();
  const current=await page.evaluate(()=>window.__capturedRefreshOwner.capture());
  expect(current.user.id).toBe(old.user.id);expect(current.refresh_token).not.toBe(old.refresh_token);
  expect(control.calls()).toBe(1);
});
for(const later of ['login','logout'] as const)test('a current renewal held before response cannot commit after later '+later,async({context,page})=>{
  const control=await install(context);await load(page);await page.evaluate(()=>window.__capturedRefreshOwner.signIn('a'));
  const old=await page.evaluate(()=>window.__capturedRefreshOwner.capture());const peer=await context.newPage();await load(peer);
  control.hold();const pending=page.evaluate(value=>window.__capturedRefreshOwner.refreshGiven(value),old);
  await expect.poll(()=>control.calls()).toBe(1);
  if(later==='login')await peer.evaluate(()=>window.__capturedRefreshOwner.signIn('b'));
  else expect(await peer.evaluate(()=>window.__capturedRefreshOwner.clear(window.__capturedRefreshOwner.snapshot()))).toBe(true);
  const before=await context.cookies(origin);control.release();
  expect(await pending).toBe(later==='login'?'AuthRefreshDiscardedError':'AuthRetryableFetchError');expect(control.calls()).toBe(1);
  expect(await context.cookies(origin)).toEqual(before);
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.events())).not.toContain('SIGNED_OUT');
});
test('ordinary current-token rotation remains supported without resetting captured ownership',async({context,page})=>{
  const control=await install(context);await load(page);await page.evaluate(()=>window.__capturedRefreshOwner.signIn('a'));
  const first=await page.evaluate(()=>window.__capturedRefreshOwner.capture());
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.refresh())).toBeNull();
  const second=await page.evaluate(()=>window.__capturedRefreshOwner.capture());
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.refresh())).toBeNull();
  const third=await page.evaluate(()=>window.__capturedRefreshOwner.capture());
  expect(second.refresh_token).not.toBe(first.refresh_token);expect(third.refresh_token).not.toBe(second.refresh_token);
  const identity=(value:Session)=>JSON.parse(Buffer.from(value.access_token.split('.')[1],'base64url').toString()).session_id;
  expect(identity(second)).toBe(identity(first));expect(identity(third)).toBe(identity(first));expect(control.calls()).toBe(2);
});
test('a token captured before same-session rotation cannot replay its retired refresh token',async({context,page})=>{
  const control=await install(context);await load(page);await page.evaluate(()=>window.__capturedRefreshOwner.signIn('a'));
  const old=await page.evaluate(()=>window.__capturedRefreshOwner.capture());expect(await page.evaluate(()=>window.__capturedRefreshOwner.refresh())).toBeNull();
  const current=await page.evaluate(()=>window.__capturedRefreshOwner.capture());const before=await context.cookies(origin);
  expect(current.refresh_token).not.toBe(old.refresh_token);expect(control.calls()).toBe(1);
  await page.clock.install();const replay=page.evaluate(value=>window.__capturedRefreshOwner.refreshGiven(value),old);await page.clock.runFor(40_000);const outcome=await replay;
  await test.info().attach('synthetic-ownership-sequence',{body:JSON.stringify({initialToken:old.refresh_token,currentToken:current.refresh_token,outcome,providerDispatches:control.calls()-1,cookiesUnchanged:JSON.stringify(await context.cookies(origin))===JSON.stringify(before)}),contentType:'application/json'});
  expect(outcome).toBe('AuthRetryableFetchError');expect(control.calls()).toBe(1);expect(await context.cookies(origin)).toEqual(before);
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.verifiedUser())).toBe(current.user.id);
  expect(await page.evaluate(()=>window.__capturedRefreshOwner.events())).not.toContain('SIGNED_OUT');
});
