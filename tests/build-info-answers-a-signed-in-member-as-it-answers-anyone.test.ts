// GET /api/build-info (Register B API-44E3F76CB80E).
//
// Public by design: it names the deployed revision and nothing else, so the
// member-role matrix is n/a and "another household's ids" has nothing to name.
// What a signed-in member adds is a session cookie on the request, and the
// promise in middleware.ts ("Do not refresh sessions … for this read-only
// response") and in the route ("No runtime hosting variable, request input,
// or network lookup is used") is that the cookie changes nothing: the answer
// is byte-for-byte the anonymous one, no session is read or refreshed, no
// database client is built, and the response may not be kept by a shared cache
// that would hand one member's response to another.
//
// Already proven in tests/build-info.test.ts and not repeated here: the
// revision is parsed from the build literal only (full 40-hex, else null),
// spoofed query/header input is ignored, only GET is exported, the cache and
// content-type headers on an anonymous request, and middleware passes an
// anonymous request through without auth while neighbouring paths still
// redirect to /login.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const MEMBER = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SESSION_COOKIE = `sb-example-auth-token=base64-${Buffer.from(JSON.stringify({
  access_token: 'test-fake-key', refresh_token: 'test-fake-key', user: { id: MEMBER },
})).toString('base64')}`;

const h = vi.hoisted(() => ({ ssr: vi.fn(), getUser: vi.fn(), server: vi.fn() }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => {
    h.ssr(...args);
    return { auth: { getUser: h.getUser } };
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: (...args: unknown[]) => h.server('createServer', ...args),
  createServiceClient: (...args: unknown[]) => h.server('createServiceClient', ...args),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-fake-key');
  vi.stubEnv('BUBALY_BUILD_REVISION', SHA);
  h.getUser.mockResolvedValue({ data: { user: { id: MEMBER } }, error: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const request = (cookie?: string) => new NextRequest('https://bubaly.example/api/build-info', {
  headers: cookie ? { cookie, 'x-build-revision': OTHER_SHA } : {},
});

describe('a signed-in member', () => {
  it('API-44E3F76CB80E gets exactly the anonymous answer, uncached, with no database client built and no network', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('Unexpected network access'); });
    vi.stubGlobal('fetch', fetchSpy);
    const { GET } = await import('@/app/api/build-info/route');
    const anonymous = Reflect.apply(GET, undefined, [request()]) as Response;
    const member = Reflect.apply(GET, undefined, [request(SESSION_COOKIE)]) as Response;

    expect(member.status).toBe(200);
    expect(await member.json()).toEqual({ revision: SHA });
    expect(await anonymous.json()).toEqual({ revision: SHA });
    for (const response of [anonymous, member]) {
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(h.server).not.toHaveBeenCalled();
    expect(h.ssr).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('API-44E3F76CB80E passes middleware without the session being read, refreshed or re-issued', async () => {
    const { middleware } = await import('../middleware');
    const response = await middleware(request(SESSION_COOKIE));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(h.ssr).not.toHaveBeenCalled();
    expect(h.getUser).not.toHaveBeenCalled();
  });
});
