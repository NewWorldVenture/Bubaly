import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { createSessionRefreshFetch } from '@/shared/auth/refresh-fetch';
import { durableCookieOptions } from '@/lib/auth/session';
import { middleware } from '@/middleware';

const origin = 'https://session-test.supabase.co';
const key = 'sb-session-test-auth-token';
const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'session@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
function session(refreshToken: string, expired: boolean) {
  const expires = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  const payload = Buffer.from(JSON.stringify({ sub: user.id, aud: 'authenticated', exp: expires })).toString('base64url');
  return { access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.synthetic`, refresh_token: refreshToken, token_type: 'bearer', expires_at: expires, expires_in: expired ? 0 : 3600, user };
}
const encode = (value: unknown) => `base64-${Buffer.from(JSON.stringify(value)).toString('base64url')}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-09T16:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('refresh fetch boundary', () => {
  it.each([408, 429, 500, 501, 502, 503, 504, 507, 509, 530, 599])('keeps HTTP %i retryable without carrying response bodies', async (status) => {
    const transport = createSessionRefreshFetch(origin, vi.fn(async () => new Response('provider diagnostic', { status, headers: { 'retry-after': '20' } })));
    const response = await transport(`${origin}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('20');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('provider diagnostic');
  });
  it.each([
    ['/api/unrelated', 'POST'],
    ['not a URL', 'POST'],
    ['https://other.supabase.co/auth/v1/token?grant_type=refresh_token', 'POST'],
    [`${origin}/rest/v1/reminders`, 'POST'],
    [`${origin}/auth/v1/logout`, 'POST'],
    [`${origin}/auth/v1/token?grant_type=password`, 'POST'],
    [`${origin}/auth/v1/token?grant_type=refresh_token&grant_type=password`, 'POST'],
    [`${origin}/auth/v1/token?grant_type=refresh_token`, 'GET'],
  ])('does not change an unrelated failure at %s (%s)', async (url, method) => {
    const original = new Response('unchanged', { status: 429 });
    expect(await createSessionRefreshFetch(origin, vi.fn(async () => original))(url, { method })).toBe(original);
  });
  it.each([400, 401, 403, 404, 422])('preserves definitive HTTP %i responses', async (status) => {
    const original = new Response('unchanged', { status });
    expect(await createSessionRefreshFetch(origin, vi.fn(async () => original))(`${origin}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' })).toBe(original);
  });
  it('preserves the original valid refresh response and its unread body', async () => {
    const value = session('rotated-refresh', false);
    const original = Response.json(value, { headers: { 'x-fixture': 'original' } });
    const response = await createSessionRefreshFetch(origin, async () => original)(`${origin}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' });
    expect(response).toBe(original);
    expect(response.bodyUsed).toBe(false);
    expect(response.headers.get('x-fixture')).toBe('original');
    expect(await response.json()).toEqual(value);
  });
  it.each([
    {}, null, [], { ...session('rotated', false), access_token: '' },
    { ...session('rotated', false), refresh_token: ' ' },
    { ...session('rotated', false), token_type: null },
    { ...session('rotated', false), expires_in: 0 },
    { ...session('rotated', false), expires_in: '3600' },
  ])('keeps malformed successful token data retryable (%j)', async (value) => {
    const response = await createSessionRefreshFetch(origin, async () => Response.json(value))(`${origin}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: 'Session refresh temporarily unavailable.' });
  });
  it('leaves successful responses for other operations untouched', async () => {
    for (const url of [`${origin}/auth/v1/token?grant_type=password`, `${origin}/auth/v1/logout`, 'https://other.invalid/auth/v1/token?grant_type=refresh_token']) {
      const original = Response.json({});
      expect(await createSessionRefreshFetch(origin, async () => original)(url, { method: 'POST' })).toBe(original);
      expect(original.bodyUsed).toBe(false);
    }
  });
  it('supports Request inputs and an explicit method override without reading the request body', async () => {
    const request = new Request(`${origin}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', body: 'synthetic refresh' });
    const raw = vi.fn<typeof fetch>(async () => new Response('busy', { status: 429 }));
    const transport = createSessionRefreshFetch(origin, raw);
    expect((await transport(request)).status).toBe(503);
    expect(request.bodyUsed).toBe(false);
    expect((await transport(request, { method: 'GET' })).status).toBe(429);
    expect(raw.mock.calls[0][0]).toBe(request);
  });
});

for (const kind of ['browser', 'server', 'native'] as const) {
  describe(`${kind} installed SDK persistence`, () => {
    function fixture(initialStatus: number, expired = true, initialResponse?: () => Response) {
      const original = session('original-refresh', expired);
      const values = new Map([[key, kind === 'native' ? JSON.stringify(original) : encode(original)]]);
      let status = initialStatus;
      let responseOverride = initialResponse;
      const calls: string[] = [];
      const deletions: string[] = [];
      const fetcher: typeof fetch = async (input) => {
        const url = String(input); calls.push(url);
        if (url.endsWith('/logout?scope=local')) return new Response(null, { status: 204 });
        if (url.includes('/auth/v1/user')) return Response.json(user);
        if (responseOverride) return responseOverride();
        if (status !== 200) return Response.json({ code: status === 400 || status === 401 ? 'refresh_token_not_found' : 'temporary_failure', message: 'Synthetic failure' }, { status, headers: { 'x-supabase-api-version': '2024-01-01' } });
        return Response.json(session('rotated-refresh', false));
      };
      const cookies = {
        getAll: () => [...values].map(([name, value]) => ({ name, value })),
        setAll: (items: { name: string; value: string; options: { maxAge?: number } }[]) => {
          for (const item of items) {
            if (item.options.maxAge === 0) { deletions.push(item.name); values.delete(item.name); }
            else values.set(item.name, item.value);
          }
        },
      };
      const global = { fetch: createSessionRefreshFetch(origin, fetcher) };
      const auth = { autoRefreshToken: false, detectSessionInUrl: false, persistSession: true, storageKey: key };
      const client = kind === 'native'
        ? createClient(origin, 'synthetic-anon', { global, auth: { ...auth, storage: {
          getItem: async (name) => values.get(name) ?? null,
          setItem: async (name, value) => { values.set(name, value); },
          removeItem: async (name) => { deletions.push(name); values.delete(name); },
        } } })
        : kind === 'browser'
          ? createBrowserClient(origin, 'synthetic-anon', { global, auth, cookies, isSingleton: false, cookieOptions: durableCookieOptions(false) })
          : createServerClient(origin, 'synthetic-anon', { global, auth, cookies, cookieOptions: durableCookieOptions(false) });
      return { client, values, calls, deletions, recover: () => { status = 200; responseOverride = undefined; } };
    }

    it.each([
      ['empty object', () => Response.json({})],
      ['missing refresh token', () => Response.json({ ...session('rotated-refresh', false), refresh_token: '' })],
      ['empty response', () => new Response(null, { status: 204 })],
      ['cancelled transport', () => { throw new DOMException('The operation was aborted.', 'AbortError'); }],
      ['timed-out transport', () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }],
    ])('retains storage after an unusable successful refresh: %s', async (_name, response) => {
      const f = fixture(200, true, response);
      const before = [...f.values];
      const pending = f.client.auth.getSession();
      await vi.advanceTimersByTimeAsync(35_000);
      const failed = await pending;
      expect.soft(f.values.has(key), 'The saved session must survive an incomplete provider response').toBe(true);
      expect(failed.error?.name).toBe('AuthRetryableFetchError');
      expect([...f.values]).toEqual(before);
      expect(f.deletions).toEqual([]);
      f.recover();
      await vi.advanceTimersByTimeAsync(120_000);
      expect((await f.client.auth.getSession()).data.session?.refresh_token).toBe('rotated-refresh');
      await f.client.auth.stopAutoRefresh();
    });

    it.each([408, 429, 507])('retains exact stored bytes after HTTP %i and later rotates successfully', async (status) => {
      const f = fixture(status);
      const before = [...f.values];
      const failed = f.client.auth.getSession();
      await vi.advanceTimersByTimeAsync(35_000);
      expect((await failed).error?.name).toBe('AuthRetryableFetchError');
      expect([...f.values]).toEqual(before);
      expect(f.deletions).toEqual([]);
      f.recover();
      // Let the SDK's failure cooldown elapse before the next foreground retry.
      await vi.advanceTimersByTimeAsync(120_000);
      expect((await f.client.auth.getSession()).data.session?.refresh_token).toBe('rotated-refresh');
      expect([...f.values]).not.toEqual(before);
      expect(f.deletions.filter(name => name === key || name.startsWith(`${key}.`))).toEqual([]);
      await f.client.auth.stopAutoRefresh();
    });
    it.each([400, 401])('clears a definitively rejected refresh (HTTP %i)', async (status) => {
      const f = fixture(status);
      const result = await f.client.auth.getSession();
      expect(result.data.session).toBeNull();
      expect(f.values.has(key)).toBe(false);
      expect(f.deletions).toContain(key);
      await f.client.auth.stopAutoRefresh();
    });
    it('restores a valid stored session without a refresh and removes it on explicit local sign-out', async () => {
      const f = fixture(200, false);
      expect((await f.client.auth.getSession()).data.session?.user.id).toBe(user.id);
      expect(f.calls.filter(url => url.includes('/token'))).toEqual([]);
      expect((await f.client.auth.signOut({ scope: 'local' })).error).toBeNull();
      expect(f.values.has(key)).toBe(false);
      expect(f.calls).toContain(`${origin}/auth/v1/logout?scope=local`);
      await f.client.auth.stopAutoRefresh();
    });
  });
}

describe('actual middleware refresh', () => {
  it.each([429, 200])('keeps cookies and avoids a login redirect after an unusable refresh (HTTP %i)', async (status) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Busy' }, { status })));
    const cookie = encode(session('original-refresh', true));
    const req = new NextRequest('https://bubaly.example/home', { headers: { cookie: `${key}=${cookie}` } });
    const pending = middleware(req);
    await vi.advanceTimersByTimeAsync(35_000);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(req.cookies.get(key)?.value).toBe(cookie);
    expect(response.cookies.getAll().filter(item => item.maxAge === 0)).toEqual([]);
  });
  it('propagates a rotated cookie to the current request and browser with private cache headers', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input).includes('/token') ? Response.json(session('rotated-refresh', false)) : Response.json(user)));
    const old = encode(session('original-refresh', true));
    const req = new NextRequest('https://bubaly.example/home', { headers: { cookie: `${key}=${old}` } });
    const response = await middleware(req);
    expect(response.status).toBe(200);
    expect(req.cookies.get(key)?.value).not.toBe(old);
    expect(response.cookies.get(key)?.value).toBe(req.cookies.get(key)?.value);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('expires')).toBe('0');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });
  it.each([400, 401])('carries session expiration and private cache headers onto the login redirect after HTTP %i', async (status) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { code: 'refresh_token_not_found', message: 'Invalid Refresh Token' },
      { status, headers: { 'x-supabase-api-version': '2024-01-01' } },
    )));
    const old = encode(session('rejected-refresh', true));
    const req = new NextRequest('https://bubaly.example/home', { headers: { cookie: `${key}=${old}` } });

    const response = await middleware(req);

    expect(response.status).toBe(307);
    const destination = new URL(response.headers.get('location') ?? '');
    expect(destination.pathname).toBe('/login');
    expect(destination.searchParams.get('redirect')).toBe('/home');
    expect(req.cookies.get(key)?.value).toBe('');
    expect(response.cookies.get(key)).toMatchObject({ value: '', maxAge: 0, path: '/' });
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('expires')).toBe('0');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });
});
