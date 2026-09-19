import { createChunks, stringFromBase64URL, stringToBase64URL } from '@supabase/ssr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ getAll: vi.fn(), set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: seam.getAll, set: seam.set }) }));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: vi.fn() }));
import { GET } from '@/app/auth/callback/route';

const ORIGIN = 'https://ordinary-pkce.supabase.co';
const KEY = 'sb-ordinary-pkce-auth-token';
const VERIFIER = `${KEY}-code-verifier`;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function user(id: string) {
  return { id, aud: 'authenticated', role: 'authenticated', email: `${id}@example.invalid`,
    app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
}
function session(id: string, expired = false, padding = '') {
  const expires_at = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  const claims = stringToBase64URL(JSON.stringify({ sub: id, session_id: `${id}-session`, exp: expires_at }));
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
  provider.mockReset().mockImplementation(async (raw, init = {}) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw));
    expect(url.origin).toBe(ORIGIN);
    const call = { url, headers: new Headers(init.headers), body: typeof init.body === 'string' ? JSON.parse(init.body) : null };
    calls.push(call);
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function callback(next = '/home') {
  return GET(new Request(`https://app.example.invalid/auth/callback?${new URLSearchParams({ code: 'synthetic-code', next })}`));
}
function applyResponse(response: Awaited<ReturnType<typeof GET>>) {
  for (const cookie of response.cookies.getAll()) {
    if (cookie.maxAge === 0) jar.delete(cookie.name); else jar.set(cookie.name, cookie.value);
  }
}
const owner = () => JSON.parse(stringFromBase64URL(jar.get(KEY)!.slice(7))).user.id;

describe('ordinary callback owns exchange separately from ambient renewal', () => {
  it.each([false, true])('does not refresh ambient B before exchanging A (expired=%s)', async expired => {
    jar.set(KEY, encode(session(B, expired)));
    const response = await callback();
    expect(new URL(response.headers.get('location')!).pathname).toBe('/home');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(seam.set).not.toHaveBeenCalled();
    expect(calls.filter(call => call.url.pathname === '/auth/v1/token')).toHaveLength(1);
    expect(owner()).toBe(B);
    expect(response.cookies.get(VERIFIER)?.maxAge).toBe(0);
    applyResponse(response);
    expect(owner()).toBe(A); expect(jar.has(VERIFIER)).toBe(false);
  });
  it('publishes the exchanged session and removes all old ambient chunks', async () => {
    jar.delete(KEY);
    const chunks = createChunks(KEY, encode(session(B, true, 'x'.repeat(9000))), 1000);
    for (const cookie of chunks) jar.set(cookie.name, cookie.value);
    const response = await callback('/dashboard/meals');
    expect(response.cookies.get(KEY)).toMatchObject({ maxAge: 34_560_000, secure: true, sameSite: 'lax', path: '/' });
    for (const cookie of chunks) expect(response.cookies.get(cookie.name)?.maxAge).toBe(0);
    applyResponse(response); expect(owner()).toBe(A);
    expect(chunks.some(cookie => jar.has(cookie.name))).toBe(false);
  });
  it('removes intermediate exchange chunks when its near-expiry token renews before publication', async () => {
    exchanged = { ...session(A, false, 'x'.repeat(12000)), expires_in: 20, expires_at: Math.floor(Date.now() / 1000) + 20 };
    allowRenewal = true;
    const response = await callback();
    expect(calls.filter(call => call.url.searchParams.get('grant_type') === 'refresh_token')).toHaveLength(1);
    expect(seam.set).not.toHaveBeenCalled();
    applyResponse(response);
    expect(owner()).toBe(A);
    expect([...jar.keys()].filter(name => name.startsWith(`${KEY}.`))).toEqual([]);
    expect(jar.has(VERIFIER)).toBe(false);
  });
  it.each([400, 503])('retains existing B and its pending verifier after exchange HTTP%s', async status => {
    exchangeStatus = status;
    const before = [...jar];
    const response = await callback('/dashboard/meals');
    expect(response.headers.get('location')).toBe('https://app.example.invalid/dashboard/meals');
    expect(response.cookies.getAll()).toEqual([]); expect([...jar]).toEqual(before);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(seam.set).not.toHaveBeenCalled();
  });
  it.each([
    ['guest', false, '/dashboard/grandparent-portal'], ['none', false, '/onboarding'], ['parent', true, '/admin'],
  ] as const)('preserves %s routing with database admin=%s', async (role, isAdmin, path) => {
    membership = role === 'none' ? [] : [{ role, family_id: 'synthetic-family' }]; admin = isAdmin;
    const response = await callback();
    expect(response.headers.get('location')).toBe(`https://app.example.invalid${path}`);
    applyResponse(response); expect(owner()).toBe(A);
  });
  it('retains exchanged A on a transient user lookup failure without claiming routing authority', async () => {
    userStatus = 503;
    const response = await callback();
    expect(response.headers.get('location')).toBe('https://app.example.invalid/home');
    expect(calls.filter(call => call.url.pathname.startsWith('/rest/'))).toHaveLength(0);
    applyResponse(response); expect(owner()).toBe(A);
  });
  it.each(['absent', 'chunked'] as const)('discards an exchange rejected by the user lookup with %s ambient storage', async layout => {
    jar.delete(KEY);
    if (layout === 'chunked') {
      for (const cookie of createChunks(KEY, encode(session(B, false, 'x'.repeat(9000))), 1000)) jar.set(cookie.name, cookie.value);
    }
    const before = [...jar]; userStatus = 401;
    const response = await callback();
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
    expect(response.cookies.getAll()).toEqual([]);
    applyResponse(response); expect([...jar]).toEqual(before);
    expect(seam.set).not.toHaveBeenCalled();
  });
});
