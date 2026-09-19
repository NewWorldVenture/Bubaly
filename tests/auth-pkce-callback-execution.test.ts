import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createChunks, stringFromBase64URL, stringToBase64URL } from '@supabase/ssr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ getAll: vi.fn(), set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: seam.getAll, set: seam.set }) }));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: vi.fn() }));
import { completeCallbackAction } from '@/app/(auth)/auth/complete/actions';
import { stitchVisitorIdentity } from '@/lib/marketing/identity';

const ORIGIN = 'https://ordinary-pkce.supabase.co';
const KEY = 'sb-ordinary-pkce-auth-token';
const VERIFIER = `${KEY}-code-verifier`;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'pkce-recovery-fixture', alg: 'ES256', use: 'sig' };
function user(id: string) {
  return { id, aud: 'authenticated', role: 'authenticated', email: `${id}@example.invalid`,
    app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
}
function session(id: string, expired = false, padding = '') {
  const expires_at = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  const claims = stringToBase64URL(JSON.stringify({ sub: id, session_id: id, iss: `${ORIGIN}/auth/v1`, aud: 'authenticated', role: 'authenticated', exp: expires_at }));
  return { access_token: `eyJhbGciOiJIUzI1NiJ9.${claims}.synthetic`, refresh_token: `synthetic-${id}`,
    token_type: 'bearer', expires_in: 3600, expires_at, user: { ...user(id), user_metadata: { padding } } };
}
const encode = (value: unknown) => `base64-${stringToBase64URL(JSON.stringify(value))}`;
type Call = { url: URL; headers: Headers; body: Record<string, unknown> | null };
let jar: Map<string, string>;
let calls: Call[];
let exchangeStatus: number;
let userStatus: number;
let membership: { role: string; family_id: string }[];
let admin: boolean;
let exchanged: ReturnType<typeof session>;
let allowRenewal: boolean;
const provider = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example.invalid');
  vi.stubEnv('SUPER_ADMIN_EMAILS', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  jar = new Map([[KEY, encode(session(B))], [VERIFIER, encode('synthetic-verifier')]]);
  calls = []; exchangeStatus = 200; userStatus = 200; admin = false;
  exchanged = session(A); allowRenewal = false;
  membership = [{ role: 'parent', family_id: 'synthetic-family' }];
  seam.getAll.mockReset().mockImplementation(() => [...jar].map(([name, value]) => ({ name, value })));
  seam.set.mockReset().mockImplementation((name, value, options) => {
    if (options?.maxAge === 0) jar.delete(name); else jar.set(name, value);
  });
  vi.mocked(stitchVisitorIdentity).mockReset();
  provider.mockReset().mockImplementation(async (raw, init = {}) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw));
    expect(url.origin).toBe(ORIGIN);
    const call = { url, headers: new Headers(init.headers), body: typeof init.body === 'string' ? JSON.parse(init.body) : null };
    calls.push(call);
    if (url.pathname.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        expect(allowRenewal).toBe(true);
        expect(call.body).toEqual({ refresh_token: exchanged.refresh_token });
        return Response.json(session(A));
      }
      expect(url.search).toBe('?grant_type=pkce');
      expect(call.body).toEqual({ auth_code: 'synthetic-code', code_verifier: 'synthetic-verifier' });
      return exchangeStatus === 200 ? Response.json(exchanged)
        : Response.json({ code: 'synthetic_failure', message: 'Synthetic rejection' }, { status: exchangeStatus });
    }
    if (url.pathname === '/auth/v1/user') {
      if (userStatus !== 200) return Response.json({ message: 'Synthetic failure' }, { status: userStatus });
      const token = call.headers.get('authorization')!.slice(7);
      return Response.json(user(JSON.parse(stringFromBase64URL(token.split('.')[1])).sub));
    }
    if (url.pathname === '/rest/v1/rpc/is_super_admin') return Response.json(admin);
    if (url.pathname === '/rest/v1/family_members') return Response.json(membership);
    throw new Error(`Unexpected synthetic path: ${url.pathname}`);
  });
  vi.stubGlobal('fetch', provider);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function fingerprint() {
  const selected = [...jar].filter(([name]) => name === VERIFIER || name.startsWith(`${VERIFIER}.`))
    .map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(selected)).digest('hex');
}
function callback(next = '/home', verifierFingerprint = fingerprint()) {
  return completeCallbackAction({ code: 'synthetic-code', next, verifierFingerprint });
}
const owner = () => JSON.parse(stringFromBase64URL(jar.get(KEY)!.slice(7))).user.id;

describe('ordinary callback action returns checked data without publishing cookies', () => {
  it.each([false, true])('keeps ambient B untouched while exchanging A (expired=%s)', async expired => {
    jar.set(KEY, encode(session(B, expired)));
    const before = [...jar], receipt = await callback();
    expect(receipt).toMatchObject({ status: 'exchanged', destination: '/home', tokens: { access_token: exchanged.access_token, refresh_token: exchanged.refresh_token } });
    expect(seam.set).not.toHaveBeenCalled(); expect([...jar]).toEqual(before); expect(owner()).toBe(B);
    expect(calls.filter(call => call.url.pathname === '/auth/v1/token')).toHaveLength(1);
  });
  it.each(['ambient', 'verifier', 'both'] as const)('does not publish old or new %s cookie chunks', async layout => {
    if (layout !== 'verifier') {
      jar.delete(KEY);
      for (const cookie of createChunks(KEY, encode(session(B, true, 'x'.repeat(9000))), 1000)) jar.set(cookie.name, cookie.value);
    }
    if (layout !== 'ambient') {
      jar.delete(VERIFIER);
      for (const cookie of createChunks(VERIFIER, encode('synthetic-verifier'), 13)) jar.set(cookie.name, cookie.value);
    }
    const before = [...jar];
    expect(await callback('/dashboard/meals')).toMatchObject({ status: 'exchanged', destination: '/dashboard/meals' });
    expect([...jar]).toEqual(before); expect(seam.set).not.toHaveBeenCalled();
  });
  it('returns privately renewed tokens if a near-expiry exchange rotates before publication', async () => {
    exchanged = { ...session(A, false, 'x'.repeat(12000)), expires_in: 20, expires_at: Math.floor(Date.now() / 1000) + 20 };
    allowRenewal = true;
    const before = [...jar], receipt = await callback();
    expect(receipt.status).toBe('exchanged');
    expect(calls.filter(call => call.url.searchParams.get('grant_type') === 'refresh_token')).toHaveLength(1);
    expect([...jar]).toEqual(before); expect(seam.set).not.toHaveBeenCalled();
  });
  it.each([400, 503])('retains ambient session and verifier after exchange HTTP%s', async status => {
    exchangeStatus = status;
    const before = [...jar], receipt = await callback();
    expect(receipt.status).toBe(status === 400 ? 'rejected' : 'unavailable');
    expect([...jar]).toEqual(before); expect(seam.set).not.toHaveBeenCalled();
    expect(calls.filter(call => call.url.pathname === '/auth/v1/user')).toEqual([]);
  });
  it.each([['guest', false, '/dashboard/grandparent-portal'], ['none', false, '/onboarding'], ['parent', true, '/admin']] as const)('preserves %s routing with database admin=%s', async (role, isAdmin, destination) => {
    membership = role === 'none' ? [] : [{ role, family_id: 'synthetic-family' }]; admin = isAdmin;
    expect(await callback()).toMatchObject({ status: 'exchanged', destination });
  });
  it('keeps the verified exchange and ordinary destination when the user read fails transiently', async () => {
    userStatus = 503;
    expect(await callback()).toMatchObject({ status: 'exchanged', destination: '/home' });
    expect(calls.filter(call => call.url.pathname.startsWith('/rest/'))).toEqual([]);
  });
  it.each(['absent', 'chunked'] as const)('rejects definitive user failure without writing %s ambient storage', async layout => {
    jar.delete(KEY);
    if (layout === 'chunked') for (const cookie of createChunks(KEY, encode(session(B, false, 'x'.repeat(9000))), 1000)) jar.set(cookie.name, cookie.value);
    const before = [...jar]; userStatus = 401;
    expect((await callback()).status).toBe('rejected'); expect([...jar]).toEqual(before); expect(seam.set).not.toHaveBeenCalled();
  });
  it.each(['absent', 'replaced', 'duplicate', 'mixed', 'gap', 'too-large'] as const)('rejects %s verifier evidence before any provider request', async kind => {
    const captured = fingerprint();
    if (kind === 'absent') jar.delete(VERIFIER);
    if (kind === 'replaced') jar.set(VERIFIER, encode('newer-verifier'));
    if (kind === 'duplicate') seam.getAll.mockImplementation(() => [...jar].map(([name, value]) => ({ name, value })).concat({ name: VERIFIER, value: encode('synthetic-verifier') }));
    if (kind === 'mixed') jar.set(`${VERIFIER}.0`, encode('synthetic-verifier'));
    if (kind === 'gap') { jar.delete(VERIFIER); jar.set(`${VERIFIER}.1`, encode('synthetic-verifier')); }
    if (kind === 'too-large') jar.set(VERIFIER, 'x'.repeat(256 * 1024 + 1));
    expect((await callback('/home', captured)).status).toBe('rejected'); expect(calls).toEqual([]); expect(seam.set).not.toHaveBeenCalled();
  });
  it.each(['logout', 'new-login', 'new-verifier'] as const)('a held exchange cannot write browser cookies after %s', async change => {
    const ordinary = provider.getMockImplementation()!;
    let release = () => {}, started = () => {};
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    provider.mockImplementation(async (raw, init) => {
      if (String(raw).includes('/token')) { started(); await gate; }
      return ordinary(raw, init);
    });
    const pending = callback(); await ready;
    if (change === 'logout') jar.clear();
    if (change === 'new-login') jar.set(KEY, encode(session(B, false, 'newer')));
    if (change === 'new-verifier') jar.set(VERIFIER, encode('newer-verifier'));
    const before = [...jar]; release();
    expect((await pending).status).toBe('exchanged'); expect([...jar]).toEqual(before); expect(seam.set).not.toHaveBeenCalled();
  });
  it.each(['access', 'refresh', 'user', 'expired', 'issuer'] as const)('rejects malformed provider %s receipt without cookies or routing', async field => {
    if (field === 'access') exchanged.access_token = 'malformed';
    if (field === 'refresh') exchanged.refresh_token = '';
    if (field === 'user') exchanged.user.id = B;
    if (field === 'expired') exchanged.expires_at = 1;
    if (field === 'issuer') {
      const claims = JSON.parse(stringFromBase64URL(exchanged.access_token.split('.')[1])); claims.iss = 'https://foreign.invalid/auth/v1';
      exchanged.access_token = `eyJhbGciOiJIUzI1NiJ9.${stringToBase64URL(JSON.stringify(claims))}.synthetic`;
    }
    // An incomplete token response is rejected by the SDK before our receipt
    // parser and is classified as unavailable. Neither class permits adoption.
    expect((await callback()).status).toBe(field === 'refresh' ? 'unavailable' : 'rejected'); expect(seam.set).not.toHaveBeenCalled();
    expect(calls.filter(call => call.url.pathname.startsWith('/rest/'))).toEqual([]);
  });
  it('rejects a private refresh that replaces the provider session even for the same user', async () => {
    exchanged = { ...session(A), expires_in: 20, expires_at: Math.floor(Date.now() / 1000) + 20 };
    allowRenewal = true;
    const original = provider.getMockImplementation()!;
    provider.mockImplementation(async (raw, init) => {
      if (String(raw).includes('grant_type=refresh_token')) {
        const rotated = session(A), claims = JSON.parse(stringFromBase64URL(rotated.access_token.split('.')[1]));
        claims.session_id = B;
        rotated.access_token = `eyJhbGciOiJIUzI1NiJ9.${stringToBase64URL(JSON.stringify(claims))}.synthetic`;
        return Response.json(rotated);
      }
      return original(raw, init);
    });
    expect((await callback()).status).toBe('rejected'); expect(seam.set).not.toHaveBeenCalled();
  });
  it('exchanges a real suffixed recovery verifier into an explicitly verified grant without cookie publication', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-grant-signing-secret');
    jar.set(VERIFIER, encode('synthetic-verifier/recovery'));
    const claims = JSON.parse(stringFromBase64URL(exchanged.access_token.split('.')[1]));
    claims.iat = Math.floor(Date.now() / 1000); claims.amr = [{ method: 'recovery', timestamp: claims.iat }];
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: jwk.kid })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    exchanged.access_token = `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    const before = [...jar], receipt = await callback('/auth/recovery');
    expect(receipt).toMatchObject({ status: 'exchanged', destination: '/auth/recovery', recovery: { identity: { userId: A, sessionId: A } } });
    expect([...jar]).toEqual(before); expect(seam.set).not.toHaveBeenCalled();
  });
  it.each(['headers', 'body'] as const)('bounds held provider %s without cookie writes or late authority', async phase => {
    vi.useFakeTimers();
    provider.mockImplementation(async () => phase === 'headers' ? new Promise<Response>(() => {})
      : new Response(new ReadableStream({ start() { /* The response body never settles. */ } })));
    const before = [...jar], pending = callback();
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await pending).status).toBe('unavailable'); expect([...jar]).toEqual(before); expect(seam.set).not.toHaveBeenCalled();
  });
  it.each(['redirect', 'oversized'] as const)('refuses a provider %s response', async failure => {
    provider.mockResolvedValue(failure === 'redirect' ? new Response(null, { status: 302, headers: { location: 'https://foreign.invalid' } })
      : Response.json({ privatePadding: 'x'.repeat(256 * 1024 + 1) }));
    expect((await callback()).status).toBe('unavailable'); expect(provider).toHaveBeenCalledOnce(); expect(seam.set).not.toHaveBeenCalled();
  });
  it('preserves the exchanged session when an optional routing query ignores cancellation', async () => {
    vi.useFakeTimers();
    const original = provider.getMockImplementation()!;
    provider.mockImplementation(async (raw, init) => String(raw).includes('/rest/') ? new Promise<Response>(() => {}) : original(raw, init));
    const pending = callback();
    await vi.advanceTimersByTimeAsync(3001);
    expect(await pending).toMatchObject({ status: 'exchanged', destination: '/home' }); expect(seam.set).not.toHaveBeenCalled();
  });
  it.each(['fork', 'link', 'failed'] as const)('returns only optional attribution intent for %s without changing visitor cookies', async decision => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-attribution-key'); jar.set('bubaly_vid', 'synthetic-visitor');
    if (decision === 'failed') vi.mocked(stitchVisitorIdentity).mockRejectedValue(new Error('Synthetic attribution failure'));
    else vi.mocked(stitchVisitorIdentity).mockResolvedValue({ decision, contactId: null });
    const before = [...jar], receipt = await callback();
    expect(receipt).toMatchObject({ status: 'exchanged', destination: '/home' });
    if (decision === 'fork') expect(receipt).toHaveProperty('visitorReset', true);
    else expect(receipt).not.toHaveProperty('visitorReset');
    expect(vi.mocked(stitchVisitorIdentity).mock.calls[0][1]).toEqual({ anonymousId: 'synthetic-visitor', email: user(A).email, userId: A });
    expect([...jar]).toEqual(before); expect(seam.set).not.toHaveBeenCalled();
  });
  it('bounds optional attribution that ignores cancellation and preserves the valid sign-in', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-attribution-key'); jar.set('bubaly_vid', 'synthetic-visitor');
    vi.mocked(stitchVisitorIdentity).mockImplementation(() => new Promise(() => {}));
    const before = [...jar], pending = callback();
    await vi.advanceTimersByTimeAsync(3001);
    expect(await pending).toMatchObject({ status: 'exchanged', destination: '/home' });
    expect([...jar]).toEqual(before); expect(seam.set).not.toHaveBeenCalled();
  });
});
