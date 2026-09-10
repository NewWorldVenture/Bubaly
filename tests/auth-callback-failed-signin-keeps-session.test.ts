import { beforeEach, describe, expect, it, vi } from 'vitest';

// /auth/callback never signs anyone OUT — but its fall-through used to answer
// every non-sign-in with `/login?error=auth`, without ever asking whether the
// visitor already had a session. Reaching it means a sign-in did not HAPPEN:
//
//   - no code at all — a bookmark, a back-navigation, or `?error=access_denied`
//     from a provider the user cancelled at;
//   - a code that is expired, already spent, or replayed from an old email.
//
// Every one of those is something a SIGNED-IN person does routinely, and each
// answered with a login page that contradicted their own cookies. A sign-in
// that did not happen must not end the session they already have.

let exchangeError: unknown = null;
let authResult: { data: { user: unknown }; error: unknown } = { data: { user: null }, error: null };

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: exchangeError }),
      getUser: async () => authResult,
    },
    rpc: async () => ({ data: false, error: null }),
    from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }) }),
  }),
  createServiceClient: () => ({}),
}));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: async () => ({ decision: 'merge' }) }));

const SESSION = 'sb-ltcxlbipiihclxwioyqj-auth-token';

async function callback(query: string, cookie?: string) {
  const { GET } = await import('@/app/auth/callback/route');
  const res = await GET(new Request(`https://www.bubaly.com/auth/callback${query}`, {
    headers: cookie ? { cookie } : {},
  }));
  return new URL(res.headers.get('location') ?? '', 'https://www.bubaly.com');
}

describe('a sign-in that did not happen keeps the session that did', () => {
  beforeEach(() => {
    exchangeError = null;
    authResult = { data: { user: null }, error: null };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('sends a signed-in visitor on their way when a stale link fails to exchange', async () => {
    exchangeError = { name: 'AuthApiError', message: 'invalid flow state, no valid flow state found' };
    authResult = { data: { user: { id: 'u1', email: 'a@b.c' } }, error: null };
    expect((await callback('?code=expired', `${SESSION}=x`)).pathname).toBe('/home');
  });

  it('honours the deep link they were headed for', async () => {
    exchangeError = { message: 'code challenge does not match' };
    authResult = { data: { user: { id: 'u1', email: 'a@b.c' } }, error: null };
    expect((await callback('?code=spent&next=%2Fdashboard%2Fcalendar', `${SESSION}=x`)).pathname)
      .toBe('/dashboard/calendar');
  });

  it('does not bounce a signed-in visitor who arrives with no code at all', async () => {
    authResult = { data: { user: { id: 'u1', email: 'a@b.c' } }, error: null };
    expect((await callback('', `${SESSION}=x`)).pathname).toBe('/home');
  });

  it('does not bounce one who cancelled at the provider', async () => {
    authResult = { data: { user: { id: 'u1', email: 'a@b.c' } }, error: null };
    expect((await callback('?error=access_denied', `${SESSION}=x`)).pathname).toBe('/home');
  });

  // The middleware's rule, applied here too: an unreachable auth server reports
  // the same empty user a signed-out visitor does.
  it('keeps a cookie-carrying visitor when the lookup itself blips', async () => {
    authResult = { data: { user: null }, error: { name: 'AuthRetryableFetchError', message: 'fetch failed' } };
    expect((await callback('?code=whatever', `${SESSION}=x`)).pathname).toBe('/home');
  });

  // The fall-through still has to work for the people it was written for.
  it('still sends a genuinely signed-out visitor to the login page', async () => {
    exchangeError = { message: 'invalid request: both auth code and code verifier should be non-empty' };
    authResult = { data: { user: null }, error: { name: 'AuthSessionMissingError', message: 'Auth session missing!' } };
    const location = await callback('?code=bad');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('auth');
  });

  it('does not keep a visitor whose token the auth server actually rejected', async () => {
    authResult = { data: { user: null }, error: { status: 401, message: 'invalid claim: bad JWT' } };
    expect((await callback('', `${SESSION}=x`)).pathname).toBe('/login');
  });

  it('records why an exchange failed instead of failing silently', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exchangeError = { message: 'invalid flow state' };
    authResult = { data: { user: { id: 'u1', email: 'a@b.c' } }, error: null };
    await callback('?code=expired', `${SESSION}=x`);
    expect(spy).toHaveBeenCalledWith('[auth-callback] code exchange failed', exchangeError);
  });
});
