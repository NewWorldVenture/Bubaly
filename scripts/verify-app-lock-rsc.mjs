// Real Next App Router transport regression. Only Auth/DB and unrelated UI
// providers are fixtures; the layout, middleware, credential store and cookie
// verifier are copied from this checkout. No external service is contacted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(path.join(tmpdir(), 'bubaly-app-lock-rsc-'));
const userId = '00000000-0000-4000-8000-0000000000a1';
const sessionId = '00000000-0000-4000-8000-000000000051';
const sentinel = 'PRIVATE-LEAF-ONLY-9e2988fc';
const statePath = path.join(fixture, 'fixture-state.json');
const salt = '0123456789abcdef0123456789abcdef';
const state = { userId, sessionId, authUnavailable: false, privateUnavailable: false,
  record: { user_id: userId, enabled: true, salt, hash: createHash('sha256').update(`${salt}:4071`).digest('hex'), revision: randomUUID() } };
let server;
let browser;
let output = '';
const reports = [];

async function put(name, content) {
  const target = path.join(fixture, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
async function copy(name) {
  const target = path.join(fixture, name);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, name), target);
}
async function persist() { await writeFile(statePath, JSON.stringify(state)); }
async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const current = server;
  const closed = new Promise(resolve => current.once('exit', resolve));
  current.kill('SIGTERM');
  const timeout = setTimeout(() => current.kill('SIGKILL'), 5000);
  await closed;
  clearTimeout(timeout);
}
async function start() {
  const port = await unusedPort();
  output = '';
  server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: fixture,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', INTERNAL_SECRET: 'fixture-app-lock-key', APP_LOCK_FIXTURE_STATE: statePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => { output += data; });
  server.stderr.on('data', data => { output += data; });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next exited: ${output}`);
    let reply;
    try { reply = await fetch(`${origin}/app-lock`, { headers: { cookie: 'sb-fixture-auth-token=session-one' } }); } catch { /* starting */ }
    if (reply?.ok) return origin;
    if (reply && reply.status >= 500) throw new Error(`Fixture compilation failed: ${await reply.text()}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Next did not start: ${output}`);
}
async function signedInContext(origin) {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'sb-fixture-auth-token', value: 'session-one', url: origin }]);
  return context;
}
async function navigateToSecret(page) {
  let settle;
  let refuse;
  const response = new Promise((resolve, reject) => { settle = resolve; refuse = reject; });
  const handler = async route => {
    const request = route.request();
    if (new URL(request.url()).pathname !== '/dashboard/secret' || request.headers().rsc !== '1') return route.continue();
    try {
      assert.ok(request.headers()['next-router-state-tree'], 'use the actual retained-layout router state');
      // Chromium can retire a streaming Flight request before CDP retains its
      // body. Buffer the identical actual request/response at the network seam;
      // no response bytes or router headers are fabricated by this fixture.
      const reply = await route.fetch({ maxRedirects: 0 });
      const body = await reply.text();
      await route.fulfill({ response: reply, body });
      settle({ status: reply.status(), headers: reply.headers(), body });
    } catch (error) { refuse(error); await route.abort(); }
  };
  await page.route('**/dashboard/secret*', handler);
  await page.getByRole('button', { name: 'Probe next route' }).click();
  const reply = await response;
  await page.unroute('**/dashboard/secret*', handler);
  return reply;
}

try {
  await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
  await put('package.json', JSON.stringify({ name: 'bubaly-app-lock-rsc-fixture', private: true }));
  await put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2020', jsx: 'preserve', module: 'esnext', moduleResolution: 'bundler', esModuleInterop: true, baseUrl: '.', paths: { '@/*': ['./*'] } } }));
  await put('next.config.mjs', `import path from 'node:path'; export default { devIndicators: false, webpack(config) { config.resolve.alias['@supabase/ssr$'] = path.resolve('./fixture/ssr.ts'); return config; } };`);
  for (const name of ['app/(app)/layout.tsx', 'lib/security/app-lock.ts', 'lib/security/app-lock-server.ts', 'lib/security/app-lock-store.ts',
    'lib/server/configured-secret.ts', 'lib/auth/redirect.ts', 'lib/auth/route-access.ts', 'lib/auth/session.ts', 'lib/marketing/page-types.ts', 'shared/auth/refresh-fetch.ts']) await copy(name);
  await persist();
  await put('fixture/sdk.ts', `import { readFileSync } from 'node:fs';
export const state = () => JSON.parse(readFileSync(process.env.APP_LOCK_FIXTURE_STATE!, 'utf8'));
export function client(cookies: { name: string; value: string }[]) {
  const signedIn = cookies.some(cookie => cookie.name === 'sb-fixture-auth-token');
  const token = () => { const s = state(); return 'header.' + Buffer.from(JSON.stringify({ sub: s.userId, session_id: s.sessionId, exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url') + '.fixture'; };
  return { auth: {
    getUser: async (accessToken?: string) => { const s=state(); return { data: { user: signedIn && !s.authUnavailable && (!accessToken || accessToken === token()) ? {id:s.userId} : null }, error: s.authUnavailable ? { name:'AuthRetryableFetchError', status:503, message:'fixture outage' } : null }; },
    getSession: async () => ({data:{session:signedIn?{access_token:token()}:null},error:null})
  } };
}
export function service() { return { from() { let userId: string | null = null; return {
  select() { return this; }, eq(column: string, value: string) { if(column==='user_id')userId=value; return this; }, abortSignal() { return this; },
  async maybeSingle() { const s=state(); return s.privateUnavailable ? {data:null,error:{message:'fixture outage'}} : {data:s.record?.user_id===userId?s.record:null,error:null}; }
}; } }; }
`);
  await put('fixture/ssr.ts', `import { client } from './sdk'; export const createServerClient = (_url: string, _key: string, options: any) => client(options.cookies.getAll());`);
  await put('lib/supabase/server.ts', `import { cookies } from 'next/headers'; import { client, service } from '@/fixture/sdk'; export const createServer = async () => client((await cookies()).getAll()); export const createServiceClient = service;`);
  await put('lib/supabase/auth.ts', `export const isSuperAdmin = async () => false;`);
  await put('lib/i18n/server.ts', `export const getTranslations = async () => (key: string) => key;`);
  await put('lib/server/family-time-zone.ts', `export const activeFamilyTimeZone = async () => 'UTC';`);
  await put('lib/server/entitlement.ts', `export const resolveEntitlement = async () => ({closed:false,locked:false}); export const closedFamilyStanding = async () => ({canReopen:false,openFamilies:[]});`);
  for (const [file, name] of [['components/ui/confirm.tsx','ConfirmProvider'], ['components/ui/toast.tsx','ToastProvider'], ['components/i18n/scoped-locale-provider.tsx','ScopedLocaleProvider'], ['components/i18n/locale-provider.tsx','FamilyTimeZoneProvider']]) {
    await put(file, `export function ${name}({children}: {children: React.ReactNode}) { return <>{children}</>; }`);
  }
  for (const [file, name] of [['components/auth/session-keeper.tsx','SessionKeeper'], ['components/app/trial-paywall-gate.tsx','TrialPaywallGate'], ['components/app/account-closed-gate.tsx','AccountClosedGate']]) await put(file, `export const ${name} = () => null;`);
  await put('components/auth/sign-out-form.tsx', `export function SignOutForm(){return <form><button>Sign out</button></form>;}`);
  await put('components/app/app-lock-boundary.tsx', `'use client'; export function AppLockBoundary({children, locked}: {children:React.ReactNode;locked:boolean}) {return locked ? <div>LOCKED-FIXTURE</div> : <>{children}</>;}`);
  await put('app/probe.tsx', `'use client'; import {useRouter} from 'next/navigation'; export default function Probe(){ const router=useRouter();return <button onClick={()=>router.push('/dashboard/secret')}>Probe next route</button>;}`);
  await put('app/layout.tsx', `import Probe from './probe'; export default function Root({children}: {children:React.ReactNode}) {return <html><body><Probe />{children}</body></html>;}`);
  await put('app/(app)/dashboard/start/page.tsx', `export default function Page(){return <div>START-PAGE-FIXTURE</div>;}`);
  await put('app/(app)/dashboard/secret/page.tsx', `export default function Page(){return <div>${sentinel}</div>;}`);
  await put('app/app-lock/page.tsx', `export default function Page(){return <div>LOCKED-FIXTURE</div>;}`);
  await put('app/fixture/unlock/route.ts', `import {NextResponse} from 'next/server'; import {createServer} from '@/lib/supabase/server'; import {readAppLockRecord} from '@/lib/security/app-lock-store'; import {readAppLockSessionId,sealAppUnlock,APP_UNLOCK_COOKIE,appUnlockCookieOptions} from '@/lib/security/app-lock-server'; export async function GET(){const db=await createServer();const {data:{user}}=await db.auth.getUser(); if(!user)return new NextResponse(null,{status:401});const loaded=await readAppLockRecord(user.id);const sid=await readAppLockSessionId(db as any,user.id); if(!loaded.ok||!loaded.record||!sid)return new NextResponse(null,{status:503});const proof=sealAppUnlock(user.id,loaded.record,sid);if(!proof)return new NextResponse(null,{status:503});const response=NextResponse.json({ok:true});response.cookies.set(APP_UNLOCK_COOKIE,proof,appUnlockCookieOptions());return response;}`);

  browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  // Control: start with the exact parent layout unlocked, then revoke only
  // its cookie while Next retains the mounted layout and its route tree.
  let origin = await start();
  let context = await signedInContext(origin);
  assert.equal((await context.request.get(`${origin}/fixture/unlock`)).status(), 200);
  let page = await context.newPage();
  assert.equal((await page.goto(`${origin}/dashboard/start`))?.status(), 200, 'baseline document compiled');
  await page.getByText('START-PAGE-FIXTURE', { exact: true }).waitFor();
  await context.clearCookies({ name: 'bubaly_app_unlock' });
  const baseline = await navigateToSecret(page);
  assert.ok(baseline.body.includes(sentinel), 'the control must reproduce the layout-only leaf disclosure');
  reports.push({ check: 'layout-only-control', leakedLeafInFlight: baseline.body.includes(sentinel), responseBytes: baseline.body.length, status: baseline.status });
  await writeFile(path.join(fixture, 'layout-only-flight.txt'), baseline.body);
  console.log(JSON.stringify(reports.at(-1)));
  await context.close();
  await stop();
  if (process.argv.includes('--baseline-only')) process.exitCode = 0;
  else {
    await copy('middleware.ts');
    origin = await start();
    context = await signedInContext(origin);
    // Every initial document and scripted RSC request is checked before Next
    // selects its route segments. A locked POST also cannot reach an action.
    for (const headers of [{}, { RSC: '1', 'Next-Router-State-Tree': encodeURIComponent(JSON.stringify(['', {children:['(app)', {children:['dashboard', {children:['start', {children:['__PAGE__',{}]}]}]}]}])) }]) {
      const reply = await context.request.get(`${origin}/dashboard/secret`, { headers, maxRedirects: 0 });
      assert.ok([303,307,308].includes(reply.status()), `locked request must redirect, got ${reply.status()}: ${await reply.text()}`);
      assert.ok(reply.headers().location?.includes('/app-lock'), 'locked redirect points to standalone lock route');
      assert.ok(!(await reply.text()).includes(sentinel));
    }
    const post = await context.request.post(`${origin}/dashboard/secret`, { headers: { 'Next-Action': 'fixture-action' }, data: '[]', maxRedirects: 0 });
    assert.ok([303,307,308].includes(post.status()), 'locked server-action POST is intercepted before routing');
    reports.push({check:'locked-document-rsc-and-post', status:'passed'});
    // Control: a genuine proof reaches the protected route.
    assert.equal((await context.request.get(`${origin}/fixture/unlock`)).status(), 200);
    page = await context.newPage();
    await page.goto(`${origin}/dashboard/start`);
    await page.getByText('START-PAGE-FIXTURE', { exact: true }).waitFor();
    await context.clearCookies({ name: 'bubaly_app_unlock' });
    const guarded = await navigateToSecret(page);
    assert.ok(!guarded.body.includes(sentinel), 'the middleware must suppress leaf Flight data after the cookie is removed');
    reports.push({check:'retained-layout-navigation-after-lock', leakedLeafInFlight:false, status:guarded.status});
    state.privateUnavailable = true;
    await persist();
    const unavailable = await context.request.get(`${origin}/dashboard/secret`, { maxRedirects:0 });
    assert.ok([303,307,308].includes(unavailable.status()), 'an unreadable private store remains closed');
    state.privateUnavailable = false;
    state.authUnavailable = true;
    await persist();
    const authUnavailable = await context.request.get(`${origin}/dashboard/secret`, { maxRedirects:0 });
    assert.ok([303,307,308].includes(authUnavailable.status()), 'a transient Auth outage does not expose a protected page');
    reports.push({check:'private-store-and-auth-outages', status:'passed'});
    await context.close();
    console.log(JSON.stringify({ok:true,nextVersion:JSON.parse(await readFile(path.join(root,'node_modules/next/package.json'),'utf8')).version,reports},null,2));
  }
} catch(error) {
  console.error(error);
  console.error(output.slice(-12_000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop();
  if (process.env.KEEP_APP_LOCK_RSC_FIXTURE === '1') console.log(`Fixture: ${fixture}`);
  else await rm(fixture, {recursive:true,force:true});
}
