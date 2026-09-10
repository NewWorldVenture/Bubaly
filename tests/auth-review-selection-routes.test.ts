import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/auth/callback/route';
import { middleware } from '@/middleware';
import { authScreenHref, resolveAuthSelection, type ReviewPlan } from '@/lib/billing/review-selection';

const mock = vi.hoisted(() => ({
  exchange: vi.fn(), user: vi.fn(), admin: vi.fn(), membership: vi.fn(), stitch: vi.fn(),
  allowlisted: false, middlewareUser: null as { id: string } | null,
  middlewareError: null as unknown, refresh: false, fetch: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({
    auth: { exchangeCodeForSession: mock.exchange, getUser: mock.user },
    rpc: mock.admin,
    from: (table: string) => {
      if (table !== 'family_members') throw new Error('Unexpected table');
      const query = { select: () => query, eq: () => query, then: (resolve: (result: unknown) => unknown) => mock.membership().then(resolve) };
      return query;
    },
  }),
  createServiceClient: () => ({}),
}));
vi.mock('@/lib/constants/super-admins', () => ({ isSuperAdminEmail: () => mock.allowlisted }));
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
function callback(query: URLSearchParams) { return GET(new Request(`https://bubaly.test/auth/callback?${query}`)); }
function location(response: Response) { return new URL(response.headers.get('location') ?? ''); }
beforeEach(() => {
  vi.clearAllMocks();
  mock.allowlisted = false; mock.middlewareUser = null; mock.middlewareError = null; mock.refresh = false;
  mock.exchange.mockResolvedValue({ error: null });
  mock.user.mockResolvedValue({ data: { user: { id: 'fixture-user', email: 'fixture@example.test' } }, error: null });
  mock.admin.mockResolvedValue({ data: false, error: null });
  mock.membership.mockResolvedValue({ data: [{ family_id: 'fixture-family', role: 'parent' }], error: null });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubGlobal('fetch', mock.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(mock.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe.each(plans)('callback retains %s without browser storage', (reviewPlan) => {
  const next = `/onboarding?reviewPlan=${reviewPlan}`;
  it('exchanges the confirmation or OAuth code and uses its explicit continuation', async () => {
    const response = await callback(new URLSearchParams({ code: 'synthetic-code', next }));
    expect(location(response).pathname + location(response).search).toBe(next);
    expect(mock.exchange).toHaveBeenCalledWith('synthetic-code');
    expect(mock.membership).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'exchange-failed', 'missing-user'])('retains the review on %s and through the next sign-in attempt', async (failure) => {
    const query = new URLSearchParams({ next });
    if (failure !== 'cancelled') query.set('code', 'synthetic-code');
    if (failure === 'exchange-failed') mock.exchange.mockResolvedValueOnce({ error: { message: 'Try again' } });
    if (failure === 'missing-user') mock.user.mockResolvedValueOnce({ data: { user: null }, error: null });
    const retry = location(await callback(query));
    expect(retry.pathname).toBe('/login');
    expect(retry.searchParams.get('error')).toBe('auth');
    const selection = resolveAuthSelection(retry.searchParams);
    expect(selection.next).toBe(next);
    const signup = new URL(authScreenHref('/signup', selection), 'https://bubaly.test');
    expect(resolveAuthSelection(signup.searchParams).next).toBe(next);
    const success = location(await callback(new URLSearchParams({ code: 'retry-code', next: selection.next! })));
    expect(success.pathname + success.search).toBe(next);
  });
  it('keeps an exchanged session on a retryable user read and does not run routing lookups', async () => {
    mock.user.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 503 } });
    const result = location(await callback(new URLSearchParams({ code: 'synthetic-code', next })));
    expect(result.pathname + result.search).toBe(next);
    expect(mock.admin).not.toHaveBeenCalled();
    expect(mock.membership).not.toHaveBeenCalled();
  });
});

describe('callback precedence and unchanged landing defaults', () => {
  it.each(['/join?token=fixture-invite#accept', '/dashboard/notes?view=shared#note'])('keeps safe explicit %s ahead of a flat choice and preserves it on failure', async (next) => {
    const query = new URLSearchParams({ code: 'synthetic-code', next, reviewPlan: 'plus_annual' });
    const destination = location(await callback(query));
    expect(destination.pathname + destination.search + destination.hash).toBe(next);
    mock.exchange.mockResolvedValueOnce({ error: { message: 'Try again' } });
    const retry = location(await callback(query));
    expect(resolveAuthSelection(retry.searchParams)).toEqual({ next, reviewPlan: null });
    expect(retry.searchParams.has('reviewPlan')).toBe(false);
  });
  it.each([
    ['parent', '/home'], ['guest', '/dashboard/grandparent-portal'], ['none', '/onboarding'], ['admin', '/admin'],
  ])('retains the default %s landing', async (kind, path) => {
    mock.allowlisted = kind === 'admin';
    mock.membership.mockResolvedValueOnce({ data: kind === 'none' ? [] : [{ role: kind }], error: null });
    const destination = location(await callback(new URLSearchParams({ code: 'synthetic-code' })));
    expect(destination.pathname).toBe(path);
  });
  it('does not mistake a failed membership read for a new account', async () => {
    mock.membership.mockResolvedValueOnce({ data: null, error: { message: 'Unavailable' } });
    expect(location(await callback(new URLSearchParams({ code: 'synthetic-code' }))).pathname).toBe('/home');
  });
  it('rejects duplicate callback destinations and hostile return URLs', async () => {
    const query = new URLSearchParams('code=synthetic-code&next=/join&next=/onboarding&reviewPlan=plus_annual');
    expect(location(await callback(query)).pathname).toBe('/home');
    expect(location(await callback(new URLSearchParams({ code: 'synthetic-code', next: '//foreign.test' }))).pathname).toBe('/home');
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
    const response = await middleware(new NextRequest('https://bubaly.test/?code=synthetic-code&reviewPlan=plus_annual'));
    const forwarded = location(response);
    expect(forwarded.pathname).toBe('/auth/callback');
    expect(forwarded.searchParams.get('code')).toBe('synthetic-code');
    const destination = location(await callback(forwarded.searchParams));
    expect(destination.pathname + destination.search).toBe('/onboarding?reviewPlan=plus_annual');
  });
  it('does not weaken encoded-slash rejection to preserve an unsafe query', async () => {
    const response = await middleware(new NextRequest('https://bubaly.test/dashboard/billing?next=%2Fadmin&view=manage'));
    expect(resolveAuthSelection(location(response).searchParams).next).toBe('/dashboard/billing');
  });
});
