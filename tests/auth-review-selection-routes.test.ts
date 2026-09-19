import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/auth/callback/route';
import { middleware } from '@/middleware';
import { completeCallback } from '@/lib/auth/callback-server';
import type { CallbackReceipt } from '@/lib/auth/callback';
import { authScreenHref, resolveAuthSelection, type ReviewPlan } from '@/lib/billing/review-selection';

const mock = vi.hoisted(() => ({
  exchange: vi.fn(), stored: vi.fn(), user: vi.fn(), admin: vi.fn(), membership: vi.fn(), stitch: vi.fn(),
  allowlisted: false, middlewareUser: null as { id: string } | null,
  middlewareError: null as unknown, refresh: false, fetch: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: () => { throw new Error('Callback admission must not publish ambient cookies'); },
  createServiceClient: () => { throw new Error('Unexpected service client'); },
}));
vi.mock('@/lib/constants/super-admins', () => ({ isSuperAdminEmail: () => mock.allowlisted }));
vi.mock('@/lib/auth/recovery-cookies', () => ({
  createPkceCookieExchange: async () => ({
    origin: 'https://fixture.supabase.co', anonymousId: null, dispose: vi.fn(),
    client: {
      auth: { exchangeCodeForSession: mock.exchange, getSession: mock.stored, getUser: mock.user },
      rpc: () => {
        const query = { retry: () => query, abortSignal: () => query,
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => mock.admin().then(resolve, reject) };
        return query;
      },
      from: (table: string) => {
        if (table !== 'family_members') throw new Error('Unexpected table');
        const query = { select: () => query, eq: () => query, retry: () => query, abortSignal: () => query,
          then: (resolve: (result: unknown) => unknown, reject: (reason: unknown) => unknown) => mock.membership().then(resolve, reject) };
        return query;
      },
    },
  }),
}));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: mock.stitch }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: {
    cookies: { setAll: (items: { name: string; value: string; options: object }[], headers: Record<string, string>) => void };
  }) => ({ auth: { getUser: async () => {
    if (mock.refresh) options.cookies.setAll([
      { name: 'sb-fixture-auth-token', value: 'synthetic-rotated', options: { path: '/', maxAge: 34560000 } },
    ], { 'cache-control': 'private, no-store', expires: '0', pragma: 'no-cache' });
    return { data: { user: mock.middlewareUser }, error: mock.middlewareError };
  } } }),
}));

const plans: ReviewPlan[] = ['basic_monthly', 'basic_annual', 'plus_monthly', 'plus_annual'];
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function providerSession() {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ sub: userId, session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    iss: 'https://fixture.supabase.co/auth/v1', aud: 'authenticated', role: 'authenticated', exp: expires })).toString('base64url');
  return { access_token: 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.synthetic', refresh_token: 'synthetic-refresh',
    token_type: 'bearer', expires_at: expires, expires_in: 3600, user: { id: userId, email: 'fixture@example.test' } };
}
function location(response: Response) { return new URL(response.headers.get('location') ?? ''); }
async function admit(query: URLSearchParams) {
  const calls = mock.exchange.mock.calls.length;
  const response = await GET(new Request('https://bubaly.test/auth/callback?' + query));
  expect(response.cookies.getAll()).toEqual([]);
  expect(mock.exchange).toHaveBeenCalledTimes(calls);
  const admitted = location(response);
  expect(admitted.pathname).toBe('/auth/complete');
  return admitted;
}
async function complete(query: URLSearchParams) {
  const admitted = await admit(query);
  expect(admitted.searchParams.has('code')).toBe(true);
  return completeCallback({ code: admitted.searchParams.get('code')!, next: admitted.searchParams.get('next')!, verifierFingerprint: 'a'.repeat(64) });
}
function destination(receipt: CallbackReceipt) {
  expect(receipt.status).toBe('exchanged');
  if (receipt.status !== 'exchanged') throw new Error('Expected owned token receipt');
  return new URL(receipt.destination, 'https://bubaly.test');
}
function retryLocation(admitted: URL) {
  // The completion UI uses this same production link builder after a failed
  // exchange; no server response installs a session or forces the login page.
  return new URL(authScreenHref('/login', { next: admitted.searchParams.get('next'), reviewPlan: null }, true), 'https://bubaly.test');
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.allowlisted = false; mock.middlewareUser = null; mock.middlewareError = null; mock.refresh = false;
  const session = providerSession();
  mock.exchange.mockResolvedValue({ data: { session }, error: null });
  mock.stored.mockResolvedValue({ data: { session }, error: null });
  mock.user.mockResolvedValue({ data: { user: { id: userId, email: 'fixture@example.test' } }, error: null });
  mock.admin.mockResolvedValue({ data: false, error: null });
  mock.membership.mockResolvedValue({ data: [{ family_id: 'fixture-family', role: 'parent' }], error: null });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  vi.stubGlobal('fetch', mock.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(mock.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe.each(plans)('callback retains %s through admission and completion', (reviewPlan) => {
  const next = '/onboarding?reviewPlan=' + reviewPlan;
  it('exchanges the code only in the action and returns its explicit continuation', async () => {
    const receipt = await complete(new URLSearchParams({ code: 'synthetic-code', next }));
    expect(destination(receipt).pathname + destination(receipt).search).toBe(next);
    expect(mock.exchange).toHaveBeenCalledWith('synthetic-code');
    expect(mock.membership).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'exchange-failed', 'missing-user'])('retains the review on %s and through the next sign-in attempt', async failure => {
    const query = new URLSearchParams({ next });
    if (failure !== 'cancelled') query.set('code', 'synthetic-code');
    const admitted = await admit(query);
    if (failure === 'cancelled') {
      expect(admitted.searchParams.get('error')).toBe('auth');
      expect(admitted.searchParams.has('code')).toBe(false);
    } else {
      if (failure === 'exchange-failed') mock.exchange.mockResolvedValueOnce({ error: { status: 400, message: 'Try again' } });
      else mock.user.mockResolvedValueOnce({ data: { user: null }, error: null });
      const receipt = await complete(query);
      expect(receipt.status).toBe('rejected');
      expect(receipt).not.toHaveProperty('tokens');
    }
    const retry = retryLocation(admitted);
    expect(retry.pathname).toBe('/login'); expect(retry.searchParams.get('error')).toBe('auth');
    const selection = resolveAuthSelection(retry.searchParams);
    expect(selection.next).toBe(next);
    const signup = new URL(authScreenHref('/signup', selection), 'https://bubaly.test');
    expect(resolveAuthSelection(signup.searchParams).next).toBe(next);
    const success = destination(await complete(new URLSearchParams({ code: 'retry-code', next: selection.next! })));
    expect(success.pathname + success.search).toBe(next);
  });
  it('returns the exchange receipt on retryable user reads without privileged routing', async () => {
    mock.user.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 503 } });
    const receipt = await complete(new URLSearchParams({ code: 'synthetic-code', next }));
    expect(destination(receipt).pathname + destination(receipt).search).toBe(next);
    expect(mock.admin).not.toHaveBeenCalled(); expect(mock.membership).not.toHaveBeenCalled();
  });
});

describe('callback precedence and unchanged landing defaults', () => {
  it.each(['/join?token=fixture-invite#accept', '/dashboard/notes?view=shared#note'])('keeps safe explicit %s ahead of a flat choice on success and failure', async next => {
    const query = new URLSearchParams({ code: 'synthetic-code', next, reviewPlan: 'plus_annual' });
    const selected = destination(await complete(query));
    expect(selected.pathname + selected.search + selected.hash).toBe(next);
    mock.exchange.mockResolvedValueOnce({ error: { status: 400 } });
    expect((await complete(query)).status).toBe('rejected');
    const retry = retryLocation(await admit(query));
    expect(resolveAuthSelection(retry.searchParams)).toEqual({ next, reviewPlan: null });
    expect(retry.searchParams.has('reviewPlan')).toBe(false);
  });
  it.each([['parent', '/home'], ['guest', '/dashboard/grandparent-portal'], ['none', '/onboarding'], ['admin', '/admin']])('retains the default %s landing', async (kind, path) => {
    mock.allowlisted = kind === 'admin';
    mock.membership.mockResolvedValueOnce({ data: kind === 'none' ? [] : [{ role: kind }], error: null });
    expect(destination(await complete(new URLSearchParams({ code: 'synthetic-code' }))).pathname).toBe(path);
  });
  it('does not mistake a failed membership read for a new account', async () => {
    mock.membership.mockResolvedValueOnce({ data: null, error: { message: 'Unavailable' } });
    expect(destination(await complete(new URLSearchParams({ code: 'synthetic-code' }))).pathname).toBe('/home');
  });
  it('rejects duplicate callback destinations and hostile return URLs', async () => {
    const query = new URLSearchParams('code=synthetic-code&next=/join&next=/onboarding&reviewPlan=plus_annual');
    expect(destination(await complete(query)).pathname).toBe('/home');
    expect(destination(await complete(new URLSearchParams({ code: 'synthetic-code', next: '//foreign.test' }))).pathname).toBe('/home');
  });
});

describe('protected review link middleware', () => {
  it.each([true, false])('retains the complete safe query when Supabase configured=%s', async (configured) => {
    if (!configured) vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const path = '/dashboard/billing?view=manage&reviewPlan=plus_annual';
    const response = await middleware(new NextRequest(`https://bubaly.test${path}`));
    expect(response.status).toBe(307);
    const retry = location(response);
    expect(retry.pathname).toBe('/login');
    expect(resolveAuthSelection(retry.searchParams).next).toBe(path);
  });
  it('retains the query, request/browser refresh cookie and private headers on a redirect', async () => {
    mock.refresh = true;
    const path = '/dashboard/billing?view=manage&reviewPlan=basic_annual';
    const request = new NextRequest(`https://bubaly.test${path}`, { headers: { cookie: 'sb-fixture-auth-token=synthetic-old' } });
    const response = await middleware(request);
    expect(resolveAuthSelection(location(response).searchParams).next).toBe(path);
    expect(request.cookies.get('sb-fixture-auth-token')?.value).toBe('synthetic-rotated');
    expect(response.cookies.get('sb-fixture-auth-token')?.value).toBe('synthetic-rotated');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('expires')).toBe('0');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });
  it('keeps a stored session during an outage instead of redirecting away from review', async () => {
    mock.middlewareError = { name: 'AuthRetryableFetchError', status: 503 };
    const response = await middleware(new NextRequest('https://bubaly.test/dashboard/billing?view=manage&reviewPlan=basic_annual', {
      headers: { cookie: 'sb-fixture-auth-token=synthetic-old' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.cookies.getAll()).toEqual([]);
  });
  it('forwards wrong-path OAuth codes with their flat choice to the existing callback', async () => {
    // The forward only fires for a browser mid-PKCE — without a verifier no
    // exchange could succeed, and forwarding a stranger's ?code= answered a
    // signed-in visitor with a login page (see oauth-code-not-a-logout).
    const response = await middleware(new NextRequest('https://bubaly.test/?code=synthetic-code&reviewPlan=plus_annual', {
      headers: { cookie: 'sb-fixture-auth-token-code-verifier=synthetic-verifier' },
    }));
    const forwarded = location(response);
    expect(forwarded.pathname).toBe('/auth/callback');
    expect(forwarded.searchParams.get('code')).toBe('synthetic-code');
    const selected = destination(await complete(forwarded.searchParams));
    expect(selected.pathname + selected.search).toBe('/onboarding?reviewPlan=plus_annual');
  });
  it('admits a no-code visit without forcing a signed-in visitor to the login page', async () => {
    // A stale link, a back-navigation, or cancelling at the provider is a
    // sign-in that did not HAPPEN — it must not end the session the visitor
    // already has. Their plan choice rides along in `next`.
    const next = '/onboarding?reviewPlan=plus_annual';
    const admitted = await admit(new URLSearchParams({ next }));
    expect(admitted.searchParams.get('next')).toBe(next);
    expect(mock.exchange).not.toHaveBeenCalled();
    expect(mock.user).not.toHaveBeenCalled();
  });
  it('does not weaken encoded-slash rejection to preserve an unsafe query', async () => {
    const response = await middleware(new NextRequest('https://bubaly.test/dashboard/billing?next=%2Fadmin&view=manage'));
    expect(resolveAuthSelection(location(response).searchParams).next).toBe('/dashboard/billing');
  });
});
