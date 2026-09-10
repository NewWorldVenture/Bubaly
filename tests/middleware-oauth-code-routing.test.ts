import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The predicate is covered in oauth-code-not-a-logout. This drives the REAL
// middleware, because the bug was never in a predicate — it was in what the
// middleware DID with a `?code=`, and a correct rule wired to nothing would
// pass every predicate test while production kept redirecting.
//
// Reproduced on the live site before the fix:
//   /api/google/calendar/callback?code=fake&state=abc
//     -> 307 /auth/callback?code=fake&state=abc
//     -> 307 /login?error=auth
// A signed-in user connected their calendar and got a login page.

const getUser = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        const result = await getUser();
        return { data: { user: result.user ?? null }, error: result.error ?? null };
      },
    },
  }),
}));

const SESSION = 'sb-example-auth-token';
const VERIFIER = 'sb-example-auth-token-code-verifier';

function request(path: string, cookies: Record<string, string> = {}) {
  const header = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  return new NextRequest(`https://www.bubaly.com${path}`, {
    method: 'GET',
    headers: header
      ? { cookie: header, 'x-forwarded-proto': 'https' }
      : { 'x-forwarded-proto': 'https' },
  });
}

const env = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };

describe('the middleware routes an OAuth code to whoever can actually use it', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    // Signed in, which is the whole point: these people had a valid session.
    getUser.mockResolvedValue({ user: { id: 'u1' } });
  });
  afterEach(() => {
    if (env.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
    if (env.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.key;
    vi.clearAllMocks();
  });

  it.each([
    '/api/google/calendar/callback',
    '/api/sync/google/callback',
    '/api/sync/outlook/callback',
  ])('lets %s reach its own handler with the provider code intact', async (path) => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(request(`${path}?code=fake_google_code&state=abc`, { [SESSION]: 'stored' }));
    expect(res.headers.get('location')).toBeNull();
  });

  it('does not hijack a marketing code on a public page', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/pricing?code=SAVE20', { [SESSION]: 'stored' }));
    expect(res.headers.get('location')).toBeNull();
  });

  // The rescue the forward exists for: Supabase's Site URL is a path that does
  // not handle the exchange, and this browser is genuinely mid-PKCE.
  it('still forwards a real Supabase code to /auth/callback', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/?code=supabase_pkce_code', { [VERIFIER]: 'v' }));
    const location = new URL(res.headers.get('location') ?? '', 'https://www.bubaly.com');
    expect(location.pathname).toBe('/auth/callback');
    expect(location.searchParams.get('code')).toBe('supabase_pkce_code');
  });
});
