// AUTH-005. A signed-out request to a protected API route was answered with a
// 307 to the HTML login page. A browser fetch follows that redirect and reads
// the login page as a 200: `res.ok` is true over a request that did nothing,
// and `res.json()` throws. So a family whose session had expired pressed Save
// and, at 48 client sites that read `res.ok` as success, was told it saved.
// Two clients handle a 401 they could never receive.
//
// A browser's script request is answered 401. A browser navigation to an API
// route (an OAuth start link) is a person, and still goes to /login, and a
// request that carries neither mark keeps the redirect it had.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUser = vi.fn();
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: () => getUser() } }),
}));

const env = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };

function request(path: string, headers: Record<string, string>, method = 'POST') {
  return new NextRequest(`http://localhost${path}`, { method, headers });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  getUser.mockResolvedValue({ data: { user: null }, error: null });
});
afterEach(() => {
  if (env.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
  if (env.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.key;
  vi.clearAllMocks();
});

describe('a signed-out API call is told to sign in, not handed the login page', () => {
  it('answers a browser fetch with 401 and a code, not a redirect', async () => {
    const { middleware } = await import('@/middleware');
    for (const [path, mode] of [['/api/ai/savings', 'cors'], ['/api/family/members', 'same-origin'], ['/api/admin/marketing/ai', 'cors']] as const) {
      const res = await middleware(request(path, { 'sec-fetch-mode': mode }));
      expect(res.status, path).toBe(401);
      expect(res.headers.get('location'), path).toBeNull();
      expect(await res.json(), path).toEqual({ code: 'unauthenticated' });
    }
  });

  it('answers a client that asks for JSON the same way', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/api/vacations/confirmation-import', { accept: 'application/json' }));
    expect(res.status).toBe(401);
  });

  it('still sends a person who navigates to an API route to /login (an OAuth start link)', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/api/sync/google/auth', { 'sec-fetch-mode': 'navigate', accept: 'text/html' }, 'GET'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/login');
  });

  it('still sends a signed-out page load to /login', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/dashboard', { 'sec-fetch-mode': 'navigate', accept: 'text/html' }, 'GET'));
    expect(res.status).toBe(307);
  });

  it('does the same when Supabase is not configured', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const { middleware } = await import('@/middleware');
    expect((await middleware(request('/api/ai/savings', { 'sec-fetch-mode': 'cors' }))).status).toBe(401);
    expect((await middleware(request('/api/sync/google/auth', { 'sec-fetch-mode': 'navigate' }, 'GET'))).status).toBe(307);
  });

  it('leaves a public API route alone', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/api/health', { 'sec-fetch-mode': 'cors' }, 'GET'));
    expect(res.status).toBe(200);
  });
});
