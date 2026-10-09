// The inbound-email webhook refuses every request while its secret is unset,
// whatever NODE_ENV the server runs under (SEC-002).
//
// middleware.ts lists /api/contact-center/email as a public callback, so the
// route's own check is the only thing in front of it. That check used to let
// every request through when CONTACT_CENTER_INBOUND_SECRET was unset and
// NODE_ENV was anything but 'production' — so a `next dev` server, or any
// self-hosted one started without NODE_ENV=production, filed anyone's mail into
// a family's inbox, ran the concierge on it, and sent an auto-reply to an
// address the sender chose. The build a server happens to run is not a security
// decision; the Twilio ingress (lib/server/twilio-ingress.ts) was fixed the
// same way.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en' } }) }));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: vi.fn() }));

const ROUTE = 'https://bubaly.example/api/contact-center/email';

async function post(headers: Record<string, string> = {}, url = ROUTE) {
  const { POST } = await import('@/app/api/contact-center/email/route');
  return POST(new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }));
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon');
  vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', '');
  mocks.admin.mockImplementation(() => { throw new Error('no household read may happen for an unauthorised request'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('an unset inbound secret refuses, whatever NODE_ENV says', () => {
  for (const env of ['production', 'development', 'test', '']) {
    it(`refuses an uncredentialed request under NODE_ENV=${JSON.stringify(env)}`, async () => {
      vi.stubEnv('NODE_ENV', env);
      const res = await post();
      expect(res.status).toBe(401);
      expect(mocks.admin).not.toHaveBeenCalled();
    });

    it(`refuses any presented credential under NODE_ENV=${JSON.stringify(env)}`, async () => {
      vi.stubEnv('NODE_ENV', env);
      expect((await post({ 'x-inbound-secret': 'anything' })).status).toBe(401);
      expect((await post({}, `${ROUTE}?key=anything`)).status).toBe(401);
      expect(mocks.admin).not.toHaveBeenCalled();
    });
  }
});

describe('a configured secret still works outside production', () => {
  it('accepts the right header under NODE_ENV=development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', 'dev-inbound-secret');
    const res = await post({ 'x-inbound-secret': 'dev-inbound-secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'no bubaly recipient' });
  });
});
