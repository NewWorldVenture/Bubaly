import { beforeEach, describe, expect, it, vi } from 'vitest';

// The middleware refuses to turn an outage into a logout — and then getUser()
// did it anyway one layer down. It returned null for a network blip, and null
// is what every caller acts on: app/(app)/admin/layout.tsx redirects to
// /login on it. So a Supabase hiccup showed a signed-in super-admin the login
// page, undoing on the very same request the distinction the middleware had
// just been careful to make.
//
// Null has to mean SIGNED OUT and nothing else.
let authResult: { data: { user: unknown }; error: unknown } = { data: { user: null }, error: null };

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ auth: { getUser: async () => authResult } }),
  createServiceClient: () => ({}),
}));
// Imported by lib/supabase/auth at module scope; none of it is on this path.
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('redirect'); }, notFound: () => {} }));
vi.mock('@/lib/server/feature-tiers', () => ({ getFeatureTiersByHref: async () => ({}) }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 0 }));
vi.mock('@/lib/server/ensure-family', () => ({ ensureActiveFamily: async () => false }));

const load = async () => (await import('@/lib/supabase/auth')).getUser;

describe('getUser reports no user only when there is no user', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it.each([
    ['a dropped connection', { name: 'AuthRetryableFetchError', message: 'fetch failed' }],
    ['a Supabase 5xx', { status: 503, message: 'service unavailable' }],
    ['a rate limit', { code: 'over_request_rate_limit', message: 'too many requests' }],
    ['a timeout', { message: 'request timed out' }],
  ])('raises on %s rather than reporting a signed-out user', async (_label, error) => {
    authResult = { data: { user: null }, error };
    await expect((await load())()).rejects.toThrow(/temporarily unavailable/i);
  });

  it('still reports no user when the session is genuinely gone', async () => {
    const getUser = await load();
    // The ordinary signed-out state on every public page.
    authResult = {
      data: { user: null },
      error: { name: 'AuthSessionMissingError', message: 'Auth session missing!' },
    };
    await expect(getUser()).resolves.toBeNull();
    // And a token the auth server actually rejected — definitive, so null.
    authResult = { data: { user: null }, error: { status: 401, message: 'invalid claim: bad JWT' } };
    await expect(getUser()).resolves.toBeNull();
  });

  it('returns the user when the lookup succeeds', async () => {
    authResult = { data: { user: { id: 'u1', email: 'a@b.c' } }, error: null };
    await expect((await load())()).resolves.toMatchObject({ id: 'u1' });
  });
});
