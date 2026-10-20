import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createBearerClient } from '@/lib/supabase/bearer';
import { GET } from '@/app/api/calendar/occurrences/route';

// Only HTTP is synthetic: auth-js, the bearer resolver and the route are real.
// A provider outage must not be presented as an expired user session, and no
// cookie or database context can substitute for an unverified bearer token.
const token = 'synthetic.bearer.token';
const userId = 'synthetic-user';
const familyId = 'synthetic-family';
const ownerMismatches: Record<string, string>[] = [{ 'X-Bubaly-User-Id': 'another-user' }, { 'X-Bubaly-Family-Id': 'another-family' }];
type Read = { path: string; authorization: string | null; cookie: string | null; query: URLSearchParams };
let reads: Read[];
let status: number | 'network';
const request = (headers: Record<string, string> = {}) => new NextRequest(
  'https://app.example.invalid/api/calendar/occurrences?fromDay=2026-10-20&days=1',
  { headers: { authorization: `Bearer ${token}`, 'X-Bubaly-User-Id': userId,
    'X-Bubaly-Family-Id': familyId, cookie: 'sb-other-auth-token=synthetic-cookie-principal', ...headers } },
);

beforeEach(() => {
  reads = [];
  status = 503;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://bearer-outage-fixture.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    expect(url.origin).toBe('https://bearer-outage-fixture.supabase.co');
    reads.push({ path: url.pathname, authorization: headers.get('authorization'), cookie: headers.get('cookie'), query: url.searchParams });
    if (url.pathname === '/auth/v1/user') {
      if (status === 'network') throw new TypeError('fetch failed: synthetic offline');
      if (status !== 200) return Response.json({ code: status === 401 ? 'bad_jwt' : status === 429 ? 'over_request_rate_limit' : 'synthetic_error', message: 'Synthetic provider refusal' },
        { status, headers: { 'x-supabase-api-version': '2024-01-01' } });
      return Response.json({ id: userId, email: 'synthetic@example.invalid' });
    }
    if (url.pathname === '/rest/v1/family_members') return Response.json([{ id: 'synthetic-member', family_id: familyId, user_id: userId, role: 'parent', is_active: true }]);
    if (url.pathname === '/rest/v1/families') return Response.json([{ id: familyId, timezone: 'UTC' }]);
    if (url.pathname === '/rest/v1/user_preferences') return Response.json({ active_family_id: familyId });
    if (url.pathname === '/rest/v1/calendar_events') return Response.json([], { headers: { 'content-range': '*/0' } });
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function expectBearerOnlyAuthRead() {
  expect(reads).toHaveLength(1);
  expect(reads[0]).toMatchObject({ path: '/auth/v1/user', authorization: `Bearer ${token}`, cookie: null });
}

async function expectUnavailable() {
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 'unavailable' });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('set-cookie')).toBeNull();
  expectBearerOnlyAuthRead();
}

describe('bearer authentication outage through the installed SDK and real calendar route', () => {
  it('observes the SDK returning a retryable 503 error rather than an invalid JWT', async () => {
    const result = await createBearerClient(token).auth.getUser(token);
    expect(result.data.user).toBeNull();
    expect(result.error).toMatchObject({ name: 'AuthRetryableFetchError', status: 503 });
    expectBearerOnlyAuthRead();
  });

  it.each([500, 502, 503, 504, 408, 429])('reports provider HTTP %s as temporary unavailability without reading family data', async code => {
    status = code;
    await expectUnavailable();
  });

  it('reports a network failure as temporary unavailability without reading family data', async () => {
    status = 'network';
    await expectUnavailable();
  });

  it.each([401, 403])('retains definitive provider HTTP %s rejection despite a browser cookie', async code => {
    status = code;
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'invalid_token' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expectBearerOnlyAuthRead();
  });

  it('recovers using the same token after the provider recovers, with user-scoped calendar reads', async () => {
    await expectUnavailable();
    status = 200;
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId, familyId, count: 0, occurrences: [] });
    expect(reads.filter(read => read.path === '/auth/v1/user')).toHaveLength(2);
    expect(reads.every(read => read.authorization === `Bearer ${token}` && read.cookie === null)).toBe(true);
    const membership = reads.find(read => read.path === '/rest/v1/family_members');
    expect(membership?.query.get('user_id')).toBe(`eq.${userId}`);
    expect(membership?.query.get('is_active')).toBe('eq.true');
    const calendars = reads.filter(read => read.path === '/rest/v1/calendar_events');
    expect(calendars).toHaveLength(2);
    expect(calendars.every(read => read.query.get('family_id') === `eq.${familyId}`)).toBe(true);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each(ownerMismatches)('still refuses a mismatched expected owner %j', async headers => {
    status = 200;
    const response = await GET(request(headers));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'context_changed' });
    expect(reads.some(read => read.path === '/rest/v1/calendar_events')).toBe(false);
    expect(reads.every(read => read.authorization === `Bearer ${token}` && read.cookie === null)).toBe(true);
  });

  it.each(['', 'Basic value', 'Bearer two words'])('does not replace malformed bearer %j with a browser cookie', async authorization => {
    const response = await GET(request({ authorization }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'invalid_token' });
    expect(reads).toEqual([]);
  });
});
