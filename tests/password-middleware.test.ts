import { NextRequest } from 'next/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ create: vi.fn(), getUser: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: (...args: unknown[]) => sdk.create(...args) }));
import { middleware } from '@/middleware';

beforeEach(() => {
  sdk.create.mockReset().mockReturnValue({ auth: { getUser: sdk.getUser } });
  sdk.getUser.mockReset().mockResolvedValue({ data: { user: null }, error: null });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://password-middleware.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-key');
});
afterEach(() => vi.unstubAllEnvs());

describe('child password action owns its session adoption', () => {
  it('does not create a cookie-writing SDK or forward an unrelated code on the exact action POST', async () => {
    const request = new NextRequest('https://app.invalid/kid-login?code=fixture', {
      method: 'POST', headers: { 'next-action': 'fixture-action', cookie: 'sb-password-middleware-auth-token=expired; sb-password-middleware-auth-token-code-verifier=fixture' },
    });
    const response = await middleware(request);
    expect(response.status).toBe(200);
    expect(response.cookies.getAll()).toEqual([]);
    expect(request.cookies.get('sb-password-middleware-auth-token')?.value).toBe('expired');
    expect(sdk.create).not.toHaveBeenCalled();
  });
  it.each([
    { path: '/kid-login', method: 'GET', action: true },
    { path: '/kid-login', method: 'POST', action: false },
    { path: '/kid-login/other', method: 'POST', action: true },
    { path: '/login', method: 'POST', action: true },
  ])('retains ordinary middleware for $method $path, action=$action', async ({ path, method, action }) => {
    await middleware(new NextRequest(`https://app.invalid${path}`, { method, headers: action ? { 'next-action': 'fixture-action' } : {} }));
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.getUser).toHaveBeenCalledTimes(1);
  });
});
