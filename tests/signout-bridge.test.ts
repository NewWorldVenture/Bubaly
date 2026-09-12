import { createChunks, stringToBase64URL } from '@supabase/ssr';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ getAll: vi.fn(), get: vi.fn(), set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: mock.getAll, get: mock.get, set: mock.set }) }));
import { POST } from '@/app/auth/signout/route';
import { decodeSignOutBridge, encodeSignOutBridge, SIGNOUT_BRIDGE_COOKIE, SIGNOUT_BRIDGE_PATH, type SignOutBridge } from '@/lib/auth/signout-bridge';
import { middleware } from '@/middleware';

const ORIGIN = 'https://logout-app.invalid';
const PROVIDER = 'https://logout-bridge.invalid';
const KEY = 'sb-logout-bridge-auth-token';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SID = '11111111-1111-4111-8111-111111111111';
const NONCE = '22222222-2222-4222-8222-222222222222';
const token = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: A, session_id: SID, exp: 1 })).toString('base64url')}.synthetic-signature`;
const encode = (value: unknown) => `base64-${stringToBase64URL(JSON.stringify(value))}`;
const provider = vi.fn<typeof fetch>();
let jar: Map<string, string>;
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PROVIDER);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-key');
  jar = new Map([[KEY, encode({ access_token: token, refresh_token: 'synthetic-refresh', user: { id: A } })]]);
  mock.getAll.mockReset().mockImplementation(() => [...jar].map(([name, value]) => ({ name, value })));
  mock.get.mockReset().mockImplementation(name => jar.has(name) ? { name, value: jar.get(name) } : undefined);
  mock.set.mockReset();
  provider.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', provider);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function request(scope = 'local', headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/auth/signout`, { method: 'POST', headers: { origin: ORIGIN, ...headers }, body: new URLSearchParams({ scope }) });
}

describe('actual compatibility POST, cookie parsing and installed token revocation', () => {
  it.each(['local', 'global'])('revokes submitted A with %s scope without auth cookie headers', async scope => {
    const response = await POST(request(scope));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe(SIGNOUT_BRIDGE_PATH);
    expect(response.cookies.getAll().map(cookie => cookie.name)).toEqual([SIGNOUT_BRIDGE_COOKIE]);
    const cookie = response.cookies.get(SIGNOUT_BRIDGE_COOKIE)!;
    expect(cookie).toMatchObject({ path: SIGNOUT_BRIDGE_PATH, httpOnly: true, secure: true, sameSite: 'strict', maxAge: 60 });
    expect(decodeSignOutBridge(cookie.value, location.searchParams.get('intent')!)).toMatchObject({ intent: { kind: 'session', userId: A, sessionId: SID }, revocation: 'confirmed' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(mock.set).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
    const [url, init] = provider.mock.calls[0];
    expect(url).toBe(`${PROVIDER}/auth/v1/logout?scope=${scope}`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(init?.credentials).toBe('omit');
    const decodedReceipt = Buffer.from(cookie.value, 'base64url').toString();
    expect(decodedReceipt).not.toContain(token);
    expect(decodedReceipt).not.toContain('synthetic-refresh');
  });
  it('leaves newer B browser cookies intact when an A response is delayed', async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    provider.mockImplementation(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = POST(request());
    await dispatched;
    const browserCookies = new Map([[KEY, encode({ user: { id: B } })]]);
    const before = browserCookies.get(KEY);
    release(new Response(null, { status: 204 }));
    const response = await pending;
    for (const cookie of response.cookies.getAll()) browserCookies.set(cookie.name, cookie.value);
    expect(browserCookies.get(KEY)).toBe(before);
    expect(decodeSignOutBridge(browserCookies.get(SIGNOUT_BRIDGE_COOKIE), new URL(response.headers.get('location')!).searchParams.get('intent')!)?.intent)
      .toEqual({ kind: 'session', userId: A, sessionId: SID });
  });
  it('reads chunked project cookies and ignores another project', async () => {
    const bytes = encode({ access_token: token, user: { id: A }, padding: 'x'.repeat(9000) });
    jar = new Map(createChunks(KEY, bytes).map(cookie => [cookie.name, cookie.value]));
    jar.set('sb-other-auth-token', 'unrelated');
    await POST(request());
    expect(new Headers(provider.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(mock.set).not.toHaveBeenCalled();
  });
  it('keeps local completion available when revocation is unconfirmed', async () => {
    provider.mockResolvedValue(new Response('{"message":"Fixture outage"}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const response = await POST(request());
    const location = new URL(response.headers.get('location')!);
    expect(decodeSignOutBridge(response.cookies.get(SIGNOUT_BRIDGE_COOKIE)?.value, location.searchParams.get('intent')!)?.revocation).toBe('unconfirmed');
    expect(response.cookies.getAll().map(cookie => cookie.name)).toEqual([SIGNOUT_BRIDGE_COOKIE]);
  });
  it('does not refresh or revoke an absent session', async () => {
    jar.clear();
    const response = await POST(request());
    expect(decodeSignOutBridge(response.cookies.get(SIGNOUT_BRIDGE_COOKIE)?.value, new URL(response.headers.get('location')!).searchParams.get('intent')!)?.intent).toEqual({ kind: 'empty' });
    expect(provider).not.toHaveBeenCalled();
  });
  it('requires explicit browser review for malformed request cookies', async () => {
    jar.set(KEY, 'malformed');
    const response = await POST(request());
    expect(decodeSignOutBridge(response.cookies.get(SIGNOUT_BRIDGE_COOKIE)?.value, new URL(response.headers.get('location')!).searchParams.get('intent')!)?.intent).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });
  it.each([{ origin: 'https://other.invalid' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }])('rejects a cross-origin signout before provider or cookie mutation', async headers => {
    const response = await POST(request('local', headers));
    expect(response.status).toBe(403);
    expect(response.cookies.getAll()).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('short-lived matching POST intent', () => {
  const receipt = (): SignOutBridge => ({ nonce: NONCE, expiresAt: Date.now() + 30_000, intent: { kind: 'session', userId: A, sessionId: SID }, revocation: 'confirmed' });
  it('accepts only the matching current nonce', () => {
    const value = receipt();
    expect(decodeSignOutBridge(encodeSignOutBridge(value), NONCE)).toEqual(value);
    expect(decodeSignOutBridge(encodeSignOutBridge(value), SID)).toBeNull();
    expect(decodeSignOutBridge(encodeSignOutBridge(value), undefined)).toBeNull();
  });
  it.each([{ expiresAt: 1 }, { expiresAt: Date.now() + 300_000 }, { intent: { kind: 'session', userId: 'bad', sessionId: SID } }, { revocation: 'false-success' }])('rejects invalid receipt data %s', patch => {
    expect(decodeSignOutBridge(encodeSignOutBridge({ ...receipt(), ...patch } as SignOutBridge), NONCE)).toBeNull();
  });
  it.each(['', 'not-json', 'x'.repeat(2049), Buffer.from('null').toString('base64url')])('rejects malformed encoded receipt', value => {
    expect(decodeSignOutBridge(value, NONCE)).toBeNull();
  });
});

describe('logout middleware has no ambient session writes', () => {
  it.each(['/auth/signout', '/auth/signout/complete?intent=fixture'])('leaves %s to its explicit intent boundary', async pathname => {
    const request = new NextRequest(`${ORIGIN}${pathname}`, { headers: { cookie: `${KEY}=expired; ${KEY}-code-verifier=fixture` } });
    const response = await middleware(request);
    expect(response.status).toBe(200);
    expect(response.cookies.getAll()).toEqual([]);
    expect(request.cookies.get(KEY)?.value).toBe('expired');
    expect(provider).not.toHaveBeenCalled();
  });
});
