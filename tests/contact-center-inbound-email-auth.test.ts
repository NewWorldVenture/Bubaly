// The inbound-email webhook's secret can arrive three ways. Two keep it out of
// the request line: the x-inbound-secret header, and HTTP Basic credentials in
// the webhook URL, which the provider sends as an Authorization header. The
// third, ?key=, is kept for a provider that can do neither and is warned about
// on every request that uses it (MAIN-F-E06 / audit C3-S5-08).
//
// A body with no bubaly recipient is acknowledged before any household read,
// so an authorised request answers 200 without touching the database and an
// unauthorised one answers 401; createServiceClient throws if it is reached.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en' } }) }));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: vi.fn() }));

const SECRET = 'inbound-secret-for-tests';
const ROUTE = 'https://bubaly.example/api/contact-center/email';
const SKIPPED = { ok: true, skipped: 'no bubaly recipient' };
const basic = (userinfo: string) => `Basic ${Buffer.from(userinfo).toString('base64')}`;

async function post(headers: Record<string, string>, url = ROUTE) {
  const { POST } = await import('@/app/api/contact-center/email/route');
  return POST(new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }));
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon');
  vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', SECRET);
  mocks.admin.mockImplementation(() => { throw new Error('no household read may happen before the recipient is known'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('inbound email accepts the secret as the password of Basic credentials', () => {
  it('authorises with any username, and does not warn', async () => {
    for (const user of ['inbound', 'bubaly', 'x', '']) {
      const res = await post({ authorization: basic(`${user}:${SECRET}`) });
      expect(res.status, `username ${JSON.stringify(user)}`).toBe(200);
      expect(await res.json()).toEqual(SKIPPED);
    }
    expect(console.warn).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('accepts the scheme case-insensitively and a secret that itself contains a colon', async () => {
    vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', 'with:colon:inside');
    const res = await post({ authorization: `basic ${Buffer.from('inbound:with:colon:inside').toString('base64')}` });
    expect(res.status).toBe(200);
  });

  it.each([
    ['the wrong password', basic(`inbound:${SECRET}x`)],
    ['the secret as the username with another password', basic(`${SECRET}:guess`)],
    ['the secret alone, with no colon', basic(SECRET)],
    ['an empty password', basic('inbound:')],
    ['credentials that are not base64', 'Basic not*base64!'],
    ['the Bearer scheme', `Bearer ${SECRET}`],
    ['an empty Authorization header', ''],
  ])('refuses %s', async (_label, authorization) => {
    const res = await post({ authorization });
    expect(res.status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('refuses everything while the secret is unset in production, Basic credentials included', async () => {
    vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', '');
    expect((await post({ authorization: basic(`inbound:${SECRET}`) })).status).toBe(401);
    expect((await post({ 'x-inbound-secret': SECRET })).status).toBe(401);
    expect((await post({}, `${ROUTE}?key=${SECRET}`)).status).toBe(401);
  });
});

describe('a request whose only credential is Basic reaches the route', () => {
  // middleware.ts reads Authorization only for the AI bridge, and lists the
  // contact-center callbacks as public, so Basic credentials are not consumed
  // or redirected on the way in. This pins that, since the runbook now sends
  // providers down this path.
  it('passes the middleware to the route, which then decides', async () => {
    const { middleware } = await import('@/middleware');
    for (const [password, status] of [[SECRET, 200], ['wrong', 401]] as const) {
      const req = new NextRequest(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basic(`inbound:${password}`) }, body: '{}' });
      expect((await middleware(req)).headers.get('x-middleware-next')).toBe('1');
      const { POST } = await import('@/app/api/contact-center/email/route');
      expect((await POST(req)).status).toBe(status);
    }
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});

describe('the other two forms are unchanged', () => {
  it('accepts the header without warning', async () => {
    const res = await post({ 'x-inbound-secret': SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SKIPPED);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('accepts the query form and warns once per request, naming both alternatives', async () => {
    const res = await post({}, `${ROUTE}?key=${encodeURIComponent(SECRET)}`);
    expect(res.status).toBe(200);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toMatch(/x-inbound-secret header or to Basic credentials/);
  });

  it('does not warn about the query string when a header or Basic credentials were presented', async () => {
    expect((await post({ 'x-inbound-secret': SECRET }, `${ROUTE}?key=stale`)).status).toBe(200);
    expect((await post({ authorization: basic(`inbound:${SECRET}`) }, `${ROUTE}?key=stale`)).status).toBe(200);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('lets the first credential presented decide: a wrong header is not rescued by right Basic credentials or a right key', async () => {
    expect((await post({ 'x-inbound-secret': 'wrong', authorization: basic(`inbound:${SECRET}`) })).status).toBe(401);
    expect((await post({ authorization: basic('inbound:wrong') }, `${ROUTE}?key=${SECRET}`)).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
