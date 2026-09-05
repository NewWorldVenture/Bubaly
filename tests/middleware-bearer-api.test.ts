// The middleware's treatment of bearer-authenticated calls to the AI edge.
//
// The mobile app (mobile/src/lib/assistant-core.ts) posts to /api/ai with an
// `Authorization: Bearer` header and no cookie session, and the Ask Bubaly
// routes (/api/ai/requests, /api/ai/runs/*) accept the same. Those handlers
// verify the token themselves and answer 401 on a bad one; the middleware must
// therefore let the request through rather than 307 it to the HTML login page
// — a redirect a JSON client cannot act on. The pass-through is deliberately
// narrow: only under /api/ai, only with a well-formed bearer header, and it
// changes nothing for cookie-less browser navigation or for any other API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUser = vi.fn();
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: () => getUser() } }),
}));

const env = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };

function request(path: string, headers: Record<string, string> = {}, method = 'POST') {
  return new NextRequest(`http://localhost${path}`, { method, headers });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  // No cookie session: what every mobile call and every signed-out visit looks like.
  getUser.mockResolvedValue({ data: { user: null }, error: null });
});
afterEach(() => {
  if (env.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
  if (env.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.key;
  vi.clearAllMocks();
});

describe('middleware — bearer calls to the AI edge reach their handlers', () => {
  it('passes a bearer request to /api/ai/requests through to the route', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/api/ai/requests', { authorization: 'Bearer eyJhbGciOi.test.token' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('does the same for /api/ai and the run controls', async () => {
    const { middleware } = await import('@/middleware');
    for (const path of ['/api/ai', '/api/ai/runs/00000000-0000-4000-8000-000000000001', '/api/ai/runs/00000000-0000-4000-8000-000000000001/pause']) {
      const res = await middleware(request(path, { authorization: 'Bearer abc.def.ghi' }));
      expect(res.status, path).toBe(200);
    }
  });

  it('still redirects the same paths when no bearer header is present', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/api/ai/requests'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/login');
  });

  it('ignores a malformed authorization header', async () => {
    const { middleware } = await import('@/middleware');
    for (const header of ['Bearer', 'Bearer ', 'Basic abc', 'Token abc', 'Bearer two words']) {
      const res = await middleware(request('/api/ai/requests', { authorization: header }));
      expect(res.status, header).toBe(307);
    }
  });

  it('does not open any other protected route to a bearer header', async () => {
    const { middleware } = await import('@/middleware');
    for (const path of ['/api/notes', '/dashboard', '/api/aim', '/dashboard/concierge/runs/x']) {
      const res = await middleware(request(path, { authorization: 'Bearer abc.def.ghi' }));
      expect(res.status, path).toBe(307);
    }
  });

  it('also passes the bearer request through when Supabase is not configured (the handler answers 503)', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const { middleware } = await import('@/middleware');
    expect((await middleware(request('/api/ai/requests', { authorization: 'Bearer abc.def.ghi' }))).status).toBe(200);
    expect((await middleware(request('/api/ai/requests'))).status).toBe(307);
  });
});
