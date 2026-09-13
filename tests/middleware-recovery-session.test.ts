import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const origin = 'https://recovery-middleware.supabase.co';
const cookieName = 'sb-recovery-middleware-auth-token';
const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', aud: 'authenticated', role: 'authenticated',
  email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
function savedSession(expired: boolean) {
  const expires_at = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  const payload = Buffer.from(JSON.stringify({ sub: user.id, session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', exp: expires_at })).toString('base64url');
  return { access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.synthetic`, refresh_token: expired ? 'old-refresh' : 'new-refresh',
    token_type: 'bearer', expires_in: 3600, expires_at, user };
}
function request(path: string, method = 'GET') {
  const encoded = `base64-${Buffer.from(JSON.stringify(savedSession(true))).toString('base64url')}`;
  return new NextRequest(`https://app.example.invalid${path}`, { method, headers: { cookie: `${cookieName}=${encoded}` } });
}
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-key');
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => String(input).includes('/token')
    ? Response.json(savedSession(false)) : Response.json(user)));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('recovery requests do not publish ambient session renewal cookies', () => {
  it.each([
    ['/auth/recovery', 'GET'], ['/auth/recovery', 'POST'],
    ['/auth/recovery?handoff=synthetic', 'POST'],
    ['/auth/callback?next=/auth/recovery&code=synthetic', 'GET'],
    ['/login?reset=1', 'GET'], ['/login?reset=1', 'POST'],
  ])('%s %s leaves the request and response cookie state untouched', async (path, method) => {
    const req = request(path, method);
    const before = req.cookies.get(cookieName)?.value;
    const response = await middleware(req);
    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(req.cookies.get(cookieName)?.value === before).toBe(true);
    expect(response.cookies.getAll()).toEqual([]);
  });

  it.each(['/home', '/login', '/login?reset=0', '/auth/recovery-extra', '/auth/callback?next=/home&code=synthetic'])('retains normal session refresh for %s', async path => {
    const req = request(path);
    const before = req.cookies.get(cookieName)?.value;
    const response = await middleware(req);
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalled();
    expect(req.cookies.get(cookieName)?.value === before).toBe(false);
    expect(response.cookies.get(cookieName)?.value).toBe(req.cookies.get(cookieName)?.value);
  });

  it.each(['/auth/recovery?code=synthetic', '/login?reset=1&code=synthetic'])('rescues a misplaced recovery code with its continuation intact: %s', async path => {
    const req = request(path);
    req.cookies.set(`${cookieName}-code-verifier`, 'synthetic-verifier');
    const response = await middleware(req);
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/callback');
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('next')).toBe('/auth/recovery');
    expect(fetch).not.toHaveBeenCalled();
  });
});
