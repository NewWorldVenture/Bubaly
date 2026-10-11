// The sign-out push detach has to get PAST the middleware, not just be accepted
// by the route.
//
// detachPushDevice (lib/push/device-registration.ts) posts to
// /api/push/unsubscribe with the leaving session's access token as a bearer and
// `credentials: 'omit'` — the browser has already cleared the cookies. /api is a
// protected prefix, so a cookie-less request there used to be answered 401 by
// the middleware's own getUser() before the route's bearer branch ever ran, and
// the leaving account's row stayed enabled on the device. These tests run the
// request through the middleware first and hand it to the route only when the
// middleware lets it continue, the way Next does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: null as unknown }));

// Middleware session lookup: the cookies are gone, so there is no user.
vi.mock('@supabase/ssr', async (original) => ({
  ...await original<typeof import('@supabase/ssr')>(),
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ getUser: async () => null }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/bearer', async (original) => ({
  ...await original<typeof import('@/lib/supabase/bearer')>(),
  createBearerClient: () => state.db,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));

const env = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
const TOKEN = 'fixture-shared-tablet-token';
let mem: InMemorySupabase;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  mem = createInMemorySupabase({ userId: 'u-parent' });
  mem.seed('push_devices', [
    { id: 'dev-parent-tablet', user_id: 'u-parent', family_id: 'fam-1', platform: 'android', provider: 'fcm', token: TOKEN, device_key: TOKEN, enabled: true },
    { id: 'dev-parent-phone', user_id: 'u-parent', family_id: 'fam-1', platform: 'android', provider: 'fcm', token: 'parent-phone', device_key: 'parent-phone', enabled: true },
  ]);
  state.db = mem;
});
afterEach(() => {
  if (env.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
  if (env.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.key;
  vi.clearAllMocks();
});

/** What the browser's fetch sends: a script request, no cookie. */
function browserFetch(path: string, method: string, headers: Record<string, string> = {}, body?: unknown) {
  return new NextRequest(`https://bubaly.test${path}`, {
    method,
    headers: { 'sec-fetch-mode': 'cors', 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Middleware first; the route only if the middleware lets the request continue. */
async function throughMiddleware(req: NextRequest, route: (r: Request) => Promise<Response>) {
  const { middleware } = await import('@/middleware');
  const gate = await middleware(req);
  if (gate.headers.get('x-middleware-next') !== '1') return { reachedRoute: false, res: gate };
  return { reachedRoute: true, res: await route(req) };
}

describe('the sign-out push detach reaches the unsubscribe route', () => {
  it("removes this device's row with the leaving session's bearer and no cookies", async () => {
    const { POST } = await import('@/app/api/push/unsubscribe/route');
    const { reachedRoute, res } = await throughMiddleware(
      browserFetch('/api/push/unsubscribe', 'POST', { authorization: 'Bearer leaving-session-token' }, { token: TOKEN }),
      POST,
    );
    expect(reachedRoute).toBe(true);
    expect(res.status).toBe(200);
    expect(mem.table('push_devices').map((d) => d.id)).toEqual(['dev-parent-phone']);
  });

  it('keeps every other cookie-less /api/push call, and a non-POST or bearer-less detach, at 401', async () => {
    const { middleware } = await import('@/middleware');
    const bearer = { authorization: 'Bearer leaving-session-token' };
    const cases: Array<[string, string, Record<string, string>]> = [
      ['/api/push/subscribe', 'POST', bearer],
      ['/api/push/unsubscribe/extra', 'POST', bearer],
      ['/api/push/unsubscribe-all', 'POST', bearer],
      ['/api/push', 'POST', bearer],
      ['/api/push/unsubscribe', 'GET', bearer],
      ['/api/push/unsubscribe', 'DELETE', bearer],
      ['/api/push/unsubscribe', 'POST', {}],
      ['/api/push/unsubscribe', 'POST', { authorization: 'Bearer two words' }],
      ['/api/push/unsubscribe', 'POST', { authorization: 'Basic abc' }],
    ];
    for (const [path, method, headers] of cases) {
      const res = await middleware(browserFetch(path, method, headers));
      expect(res.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(401);
    }
    expect(mem.table('push_devices')).toHaveLength(2);
  });
});
