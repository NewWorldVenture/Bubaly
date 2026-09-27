import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Real React, media hook, cache-session observer, browser cookie adapter and
// installed Supabase SDK. Two pages share actual browser cookies. Only auth /
// Storage HTTP receipts and a synthetic pixel are controlled; no live provider,
// application server, production account or private image is used.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
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
const origin = 'https://media-session-fixture.invalid';
const provider = 'https://media-session-fixture.supabase.co';
const users = { A: '11111111-1111-4111-8111-111111111111', B: '22222222-2222-4222-8222-222222222222' };
const object = '33333333-3333-4333-8333-333333333333/photos/synthetic.png';
const reference = `${provider}/storage/v1/object/public/family-media/${object}`;
const signedPath = `/object/sign/family-media/${object}?token=synthetic-a-only`;
const signedA = `${provider}/storage/v1${signedPath}`;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOsAAAAASUVORK5CYII=', 'base64');
type Owner = keyof typeof users;
type Snapshot = { status: string; owner: Owner | null; cookieOwner: Owner | null; generation: number; hasImage: boolean; srcIsA: boolean; imageDecoded: boolean; lookupIsA: boolean };
type ImageSnapshot = { tag: string | null; busy: string | null; hasImage: boolean; imageDecoded: boolean; srcIsA: boolean };
type Probe = { hydrate: (markup: string, reference: string) => void; spa: (reference: string) => ImageSnapshot; view: () => ImageSnapshot; recoverable: number; signIn: () => Promise<void>; mount: () => void; unmount: () => void; settle: () => Promise<void>; snapshot: () => Snapshot; join: () => void; signingSettled: number; joinedSettled: boolean };
declare global { interface Window { __familyMediaOwnership: Probe } }
type State = { owner: Owner; signingOwners: string[]; imageOwners: Owner[]; unexpected: number; pageErrors: number; hydrationWarnings: number; consoleErrors: number; holdSigning: boolean; pending: Array<{ owner: string; release: () => Promise<void> }> };

function receipt(owner: Owner) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const claims = { sub: users[owner], session_id: owner === 'A' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', exp: expires, aud: 'authenticated' };
  const access_token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-signature'].join('.');
  return { access_token, refresh_token: `synthetic-${owner}`, token_type: 'bearer', expires_in: 3600, expires_at: expires,
    user: { id: users[owner], aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-09-27T00:00:00Z' } };
}
async function install(context: BrowserContext, holdSigning = false): Promise<State> {
  const state: State = { owner: 'A', signingOwners: [], imageOwners: [], unexpected: 0, pageErrors: 0, hydrationWarnings: 0, consoleErrors: 0, holdSigning, pending: [] };
  const sessions = { A: receipt('A'), B: receipt('B') };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'cache-control': 'no-store' };
    if (url.origin === origin && request.method() === 'GET') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><main id="root"></main></body></html>' }); return;
    }
    if (url.origin !== provider) { state.unexpected++; await route.abort(); return; }
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    const owner = (['A', 'B'] as const).find(value => request.headers().authorization === `Bearer ${sessions[value].access_token}`);
    if (url.pathname === '/auth/v1/token' && request.method() === 'POST') {
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(sessions[state.owner]) }); return;
    }
    if (url.pathname === '/auth/v1/user' && request.method() === 'GET' && owner) {
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(sessions[owner].user) }); return;
    }
    if (url.pathname === '/storage/v1/object/sign/family-media' && request.method() === 'POST') {
      state.signingOwners.push(owner ?? 'unknown');
      const payload = request.postDataJSON() as { paths?: string[] };
      if (!owner || payload.paths?.length !== 1 || payload.paths[0] !== object) { state.unexpected++; await route.abort(); return; }
      const response = { contentType: 'application/json', headers, body: JSON.stringify([{ path: object, signedURL: owner === 'A' ? signedPath : null, error: owner === 'A' ? null : 'not authorized' }]) };
      if (state.holdSigning) {
        await new Promise<void>(resolve => state.pending.push({ owner, release: async () => { await route.fulfill(response); resolve(); } })); return;
      }
      await route.fulfill(response); return;
    }
    if (url.href === signedA && request.method() === 'GET') {
      state.imageOwners.push(state.owner);
      await route.fulfill({ contentType: 'image/png', headers, body: pixel }); return;
    }
    if (url.href === `${provider}/public-external.png` && request.method() === 'GET') {
      await route.fulfill({ contentType: 'image/png', headers, body: pixel }); return;
    }
    state.unexpected++; await route.abort();
  });
  return state;
}
async function load(page: Page, state: State) {
  page.on('pageerror', () => state.pageErrors++);
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (/did not match|hydration|hydrating|server HTML/i.test(message.text())) state.hydrationWarnings++;
    else state.consoleErrors++;
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources=${JSON.stringify(modules)}, entries=${JSON.stringify(entries)}, loaded={};
    const process={env:{NEXT_PUBLIC_SUPABASE_URL:${JSON.stringify(provider)},NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-anon'}};
    function load(id) {
      if(id==='react')return window.React;
      if(id==='@supabase/supabase-js')return window.supabase;
      if(loaded[id])return loaded[id].exports;
      const item=sources[id];if(!item)throw new Error('Unexpected fixture module');
      const module=loaded[id]={exports:{}};
      new Function('require','module','exports','process',item.source)(name=>load(item.imports[name]),module,module.exports,process);
      return module.exports;
    }
    const db=load(entries['lib/supabase/client.ts']).createClient();
    const auth=load(entries['lib/auth/cache-session.ts']);
    const media=load(entries['lib/storage/use-family-media.ts']);
    const cache=load(entries['lib/offline/cache.ts']);
    const storage=load(entries['lib/auth/browser-session-storage.ts']);
    const Component=load(entries['components/media/family-media-img.tsx']).FamilyMediaImg;
    const p=window.__familyMediaOwnership={signingSettled:0,joinedSettled:false,recoverable:0};
    // Neutral observation of the real SDK's settlement; arguments, responses,
    // cookie behavior and the media implementation are not replaced.
    const originalFrom=db.storage.from.bind(db.storage);
    db.storage.from=(...args)=>{const bucket=originalFrom(...args),sign=bucket.createSignedUrls.bind(bucket);bucket.createSignedUrls=(...values)=>sign(...values).finally(()=>{p.signingSettled++;});return bucket;};
    const label=id=>id===${JSON.stringify(users.A)}?'A':id===${JSON.stringify(users.B)}?'B':null;
    function ImageView(){const src=media.useFamilyMediaUrl(${JSON.stringify(reference)});return src?React.createElement('img',{id:'private-image',alt:'Synthetic fixture image',src}):React.createElement('output',{id:'no-image'},src===null?'denied':'loading');}
    function Observer(){const s=React.useSyncExternalStore(auth.subscribeCacheSession,auth.getCacheSessionSnapshot,auth.getServerCacheSessionSnapshot);return React.createElement('section',{'data-owner':label(s.identity?.userId),'data-status':s.status},s.status==='ready'?React.createElement(ImageView):React.createElement('output',null,'restoring'));}
    let root=null;
    p.view=()=>{const item=document.getElementById('root').firstElementChild;return {tag:item?.tagName??null,busy:item?.getAttribute('aria-busy')??null,hasImage:item?.tagName==='IMG',imageDecoded:item?.tagName==='IMG'&&item.complete&&item.naturalWidth===1,srcIsA:item?.tagName==='IMG'&&item.src===${JSON.stringify(signedA)}};};
    p.hydrate=(markup,reference)=>{document.getElementById('root').innerHTML=markup;root=ReactDOM.hydrateRoot(document.getElementById('root'),React.createElement(Component,{src:reference,alt:'Synthetic SSR image'}),{onRecoverableError:()=>p.recoverable++});};
    p.spa=(reference)=>{ReactDOM.flushSync(()=>root.unmount());root=ReactDOM.createRoot(document.getElementById('root'));ReactDOM.flushSync(()=>root.render(React.createElement(Component,{src:reference,alt:'Synthetic SSR image'})));return p.view();};
    p.mount=()=>{if(root)throw new Error('Already mounted');root=ReactDOM.createRoot(document.getElementById('root'));ReactDOM.flushSync(()=>root.render(React.createElement(Observer)));};
    p.unmount=()=>{if(!root)throw new Error('Not mounted');ReactDOM.flushSync(()=>root.unmount());root=null;};
    p.signIn=async()=>{const {error}=await db.auth.signInWithPassword({email:'fixture@example.invalid',password:'synthetic-not-real'});if(error)throw error;};
    p.join=()=>{void media.ensureFamilyMediaUrls([${JSON.stringify(reference)}]).finally(()=>{p.joinedSettled=true;});};
    p.settle=async()=>{await auth.refreshCacheSession();await new Promise(r=>setTimeout(r,0));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));};
    p.snapshot=()=>{const s=auth.getCacheSessionSnapshot(),i=document.getElementById('private-image'),c=storage.captureBrowserSessionSnapshot();return {status:s.status,owner:label(s.identity?.userId),cookieOwner:label(c?.userId),generation:cache.getCacheGeneration(),hasImage:!!i,srcIsA:!!i&&i.src===${JSON.stringify(signedA)},imageDecoded:!!i&&i.complete&&i.naturalWidth===1,lookupIsA:media.lookupFamilyMediaUrl(${JSON.stringify(reference)})===${JSON.stringify(signedA)}};};
  })();` });
}
const snapshot = (page: Page) => page.evaluate(() => window.__familyMediaOwnership.snapshot());
async function switchPeer(context: BrowserContext, page: Page, state: State) {
  const peer = await context.newPage(); await load(peer, state); state.owner = 'B';
  await peer.evaluate(() => window.__familyMediaOwnership.signIn());
  await expect.poll(async () => (await snapshot(page)).cookieOwner).toBe('B');
}
async function denied(page: Page, state: State) {
  await expect(page.locator('#no-image')).toHaveText('denied');
  expect(await snapshot(page)).toMatchObject({ status: 'ready', owner: 'B', cookieOwner: 'B', hasImage: false, srcIsA: false, lookupIsA: false });
  expect(state.signingOwners).toEqual(['A', 'B']);
  expect(state.unexpected).toBe(0); expect(state.pageErrors).toBe(0);
}

test.use({ serviceWorkers: 'block' });
for (const gap of [false, true]) {
  test(gap ? 'a ready B remount never renders A signed media after an observer gap' : 'an actively observed peer switch purges A signed media before B denial', async ({ page, context }) => {
    const state = await install(context); await load(page, state);
    await page.evaluate(() => window.__familyMediaOwnership.signIn());
    await page.evaluate(() => window.__familyMediaOwnership.mount());
    await expect.poll(async () => (await snapshot(page)).imageDecoded).toBe(true);
    expect(await snapshot(page)).toMatchObject({ owner: 'A', cookieOwner: 'A', generation: 0, srcIsA: true });
    expect(state.imageOwners).toEqual(['A']);
    if (gap) {
      await page.evaluate(() => window.__familyMediaOwnership.unmount());
      expect(await snapshot(page)).toMatchObject({ status: 'restoring', owner: null, hasImage: false });
    }
    await switchPeer(context, page, state);
    if (gap) await page.evaluate(() => window.__familyMediaOwnership.mount());
    await denied(page, state);
    expect((await snapshot(page)).generation).toBe(gap ? 0 : 1);
    expect(state.imageOwners).toEqual(['A']);
  });
}
for (const order of [['B', 'A'], ['A', 'B']] as const) {
  test(`held A signing cannot cross an observer gap or erase B pending work: ${order.join(' then ')}`, async ({ page, context }) => {
    const state = await install(context, true); await load(page, state);
    await page.evaluate(() => window.__familyMediaOwnership.signIn());
    await page.evaluate(() => window.__familyMediaOwnership.mount());
    await expect.poll(() => state.pending.map(item => item.owner)).toEqual(['A']);
    await page.evaluate(() => window.__familyMediaOwnership.unmount());
    await switchPeer(context, page, state);
    await page.evaluate(() => window.__familyMediaOwnership.mount());
    await expect.poll(() => state.pending.map(item => item.owner)).toEqual(['A', 'B']);
    expect(state.signingOwners).toEqual(['A', 'B']);
    await state.pending.find(item => item.owner === order[0])!.release();
    await expect.poll(() => page.evaluate(() => window.__familyMediaOwnership.signingSettled)).toBe(1);
    await page.evaluate(() => window.__familyMediaOwnership.settle());
    expect(await snapshot(page)).toMatchObject({ owner: 'B', cookieOwner: 'B', hasImage: false, lookupIsA: false });
    await page.evaluate(() => window.__familyMediaOwnership.join());
    await page.evaluate(() => window.__familyMediaOwnership.settle());
    expect(state.signingOwners).toEqual(['A', 'B']);
    await state.pending.find(item => item.owner === order[1])!.release();
    await expect.poll(() => page.evaluate(() => ({ settled: window.__familyMediaOwnership.signingSettled, joined: window.__familyMediaOwnership.joinedSettled }))).toEqual({ settled: 2, joined: true });
    await denied(page, state);
    expect(state.imageOwners).toEqual([]);
  });
}

// Render the same compiled production module graph in Node without a DOM, then
// hydrate its markup with actual React in Chromium. Only transport is synthetic.
function serverMarkup(reference: string): string {
  const loaded: Record<string, { exports: Record<string, unknown> }> = {};
  function load(id: string): unknown {
    if (id === 'react') return React;
    if (id === '@supabase/supabase-js') return require('@supabase/supabase-js');
    if (loaded[id]) return loaded[id].exports;
    const item = modules[id];
    if (!item) throw new Error('Unexpected SSR fixture module');
    const loadedModule = loaded[id] = { exports: {} };
    new Function('React', 'require', 'module', 'exports', 'process', item.source)(
      React, (name: string) => load(item.imports[name]), loadedModule, loadedModule.exports,
      { env: { NEXT_PUBLIC_SUPABASE_URL: provider, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon' } },
    );
    return loadedModule.exports;
  }
  const { FamilyMediaImg } = load(entries['components/media/family-media-img.tsx']) as {
    FamilyMediaImg: React.ComponentType<{ src: string; alt: string }>;
  };
  return renderToString(React.createElement(FamilyMediaImg, { src: reference, alt: 'Synthetic SSR image' }));
}
for (const kind of ['valid', 'absent', 'external'] as const) {
  test(`FamilyMediaImg hydrates without markup mismatch for ${kind} ownership`, async ({ page, context }) => {
    expect(typeof document).toBe('undefined');
    const state = await install(context, true); await load(page, state);
    const src = kind === 'external' ? `${provider}/public-external.png` : reference;
    const markup = serverMarkup(src);
    if (kind === 'valid') await page.evaluate(() => window.__familyMediaOwnership.signIn());
    await page.evaluate(({ markup, src }) => window.__familyMediaOwnership.hydrate(markup, src), { markup, src });
    if (kind === 'valid') {
      await expect.poll(() => state.pending.map(item => item.owner)).toEqual(['A']);
      await page.evaluate(() => window.__familyMediaOwnership.settle());
      expect(await page.evaluate(() => window.__familyMediaOwnership.view())).toMatchObject({ tag: 'SPAN', busy: 'true', hasImage: false });
      await state.pending[0].release();
      await expect.poll(() => page.evaluate(() => window.__familyMediaOwnership.view().imageDecoded)).toBe(true);
      // A subsequent SPA mount must use an already-owned cache entry immediately.
      expect(await page.evaluate(src => window.__familyMediaOwnership.spa(src), src)).toMatchObject({ hasImage: true, srcIsA: true });
      expect(state.signingOwners).toEqual(['A']);
    } else if (kind === 'external') {
      await expect.poll(() => page.evaluate(() => window.__familyMediaOwnership.view().imageDecoded)).toBe(true);
      expect(markup.startsWith('<img')).toBe(true);
      expect(state.signingOwners).toEqual([]);
    } else {
      await page.evaluate(() => window.__familyMediaOwnership.settle());
      await expect.poll(() => page.evaluate(() => window.__familyMediaOwnership.view())).toMatchObject({ tag: 'SPAN', busy: null, hasImage: false });
      expect(state.signingOwners).toEqual([]);
    }
    expect(markup.includes('aria-busy="true"')).toBe(kind !== 'external');
    expect(await page.evaluate(() => window.__familyMediaOwnership.recoverable)).toBe(0);
    expect(state.hydrationWarnings).toBe(0); expect(state.consoleErrors).toBe(0);
    expect(state.pageErrors).toBe(0); expect(state.unexpected).toBe(0);
  });
}
