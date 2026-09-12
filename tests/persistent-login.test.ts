// Persistent login: once someone signs in they stay signed in until THEY sign
// out. These are the seams where that promise is actually kept or broken — a
// cookie that dies with the tab, a network blip read as a logout, a rotated
// refresh token spent twice, a sign-out on one device ending another's session.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  SESSION_COOKIE_MAX_AGE, durableCookieOptions, hasAuthCookies, isAuthCookieName,
  isRetryableAuthError, isSecureOrigin, isSecureRequest,
} from '@/lib/auth/session';
import { isRetryableAuthError as mobileIsRetryableAuthError } from '@/mobile/src/lib/auth-core';

describe('session cookie lifetime', () => {
  it('outlives the tab — the 400-day browser ceiling, never a session cookie', () => {
    expect(SESSION_COOKIE_MAX_AGE).toBe(400 * 24 * 60 * 60);
    expect(durableCookieOptions(true).maxAge).toBe(SESSION_COOKIE_MAX_AGE);
  });

  it('scopes the session to the whole app and keeps it on inbound navigations', () => {
    // `strict` would drop the cookie on an emailed link, the OAuth return, or a
    // push-notification tap — every case where a signed-in user arrives from
    // outside and expects to already be signed in.
    const options = durableCookieOptions(true);
    expect(options.path).toBe('/');
    expect(options.sameSite).toBe('lax');
  });

  it('marks the cookie Secure on https and omits it everywhere else', () => {
    // A Secure cookie on a plain-http origin is discarded by the browser, which
    // reads as an instant logout on the localhost dev server and the Capacitor
    // LAN shell — so the attribute has to be absent, not `secure: false`.
    expect(durableCookieOptions(true).secure).toBe(true);
    expect('secure' in durableCookieOptions(false)).toBe(false);
  });
});

describe('https detection is conservative', () => {
  it('trusts the proxy header ahead of the request URL', () => {
    expect(isSecureRequest({ forwardedProto: 'https', url: 'http://internal:3000' })).toBe(true);
    expect(isSecureRequest({ forwardedProto: 'https,http', url: null })).toBe(true);
    expect(isSecureRequest({ forwardedProto: 'http', url: 'https://www.bubaly.com' })).toBe(false);
  });

  it('falls back to the origin, and answers false when it cannot tell', () => {
    expect(isSecureRequest({ url: 'https://www.bubaly.com' })).toBe(true);
    expect(isSecureRequest({ url: 'http://localhost:3000' })).toBe(false);
    expect(isSecureRequest({})).toBe(false);
    expect(isSecureOrigin('not a url')).toBe(false);
    expect(isSecureOrigin(undefined)).toBe(false);
  });
});

describe('recognising a stored session', () => {
  it('matches the Supabase auth cookie and its chunks', () => {
    expect(isAuthCookieName('sb-abcdefghij-auth-token')).toBe(true);
    expect(isAuthCookieName('sb-abcdefghij-auth-token.0')).toBe(true);
    expect(isAuthCookieName('sb-abcdefghij-auth-token.11')).toBe(true);
  });

  it('does not mistake a sign-in in progress, or an unrelated cookie, for a session', () => {
    // The PKCE verifier exists between clicking "Continue with Google" and the
    // callback; treating it as a session would keep a half-finished sign-in alive.
    expect(isAuthCookieName('sb-abcdefghij-auth-token-code-verifier')).toBe(false);
    expect(isAuthCookieName('bubaly_vid')).toBe(false);
    expect(isAuthCookieName('sb-provider-token')).toBe(false);
  });

  it('answers whether a request still carries one', () => {
    expect(hasAuthCookies(['bubaly_vid', 'sb-xyz-auth-token.0'])).toBe(true);
    expect(hasAuthCookies(['bubaly_vid', 'locale'])).toBe(false);
    expect(hasAuthCookies([])).toBe(false);
  });
});

describe('an outage is not a logout', () => {
  it('treats network, timeout, rate-limit and 5xx failures as retryable', () => {
    const retryable: unknown[] = [
      Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError' }),
      { status: 503, message: 'Service Unavailable' },
      { status: 429, message: 'Too many requests' },
      { status: 408, message: 'Request Timeout' },
      { status: 0, message: '' },
      { code: 'network_error' },
      new Error('fetch failed'),
      new Error('socket hang up'),
      new Error('ECONNRESET'),
    ];
    for (const error of retryable) expect(isRetryableAuthError(error), String(error)).toBe(true);
  });

  it('treats a definitive rejection as a real end of session', () => {
    // Only the auth server saying "this token is no longer valid" ends a session.
    const terminal: unknown[] = [
      { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 },
      { name: 'AuthApiError', message: 'Invalid Refresh Token: Already Used', status: 401 },
      { name: 'AuthApiError', message: 'refresh_token_not_found', status: 400, code: 'refresh_token_not_found' },
      null,
      undefined,
      'nope',
    ];
    for (const error of terminal) expect(isRetryableAuthError(error), String(error)).toBe(false);
  });

  it('classifies identically on the mobile side', () => {
    // mobile/src/lib/auth-core.ts carries its own copy (Metro cannot resolve the
    // web lib/), so the two must not drift — they gate the same decision.
    const cases: unknown[] = [
      Object.assign(new Error('x'), { name: 'AuthRetryableFetchError' }),
      { status: 500 }, { status: 401 }, { code: 'network_error' },
      new Error('Network request failed'), new Error('Invalid Refresh Token'), null,
    ];
    for (const error of cases) {
      expect(mobileIsRetryableAuthError(error), String(error)).toBe(isRetryableAuthError(error));
    }
  });
});

// Hoisted above the describe: vi.mock is lifted to the top of the module, so
// anything its factory reaches for must live at module scope too.
const getUser = vi.fn();
const setAllSpy = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: {
    cookies: { setAll: (t: { name: string; value: string; options: object }[]) => void };
  }) => ({
    auth: {
      getUser: async () => {
        const result = await getUser();
        if (result.refreshed) {
          options.cookies.setAll(result.refreshed);
          setAllSpy(result.refreshed);
        }
        return { data: { user: result.user ?? null }, error: result.error ?? null };
      },
    },
  }),
}));

describe('middleware keeps a signed-in user signed in', () => {
  const env = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };

  function request(path: string, cookies: Record<string, string> = {}) {
    const header = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    return new NextRequest(`https://www.bubaly.com${path}`, {
      method: 'GET',
      headers: header ? { cookie: header, 'x-forwarded-proto': 'https' } : { 'x-forwarded-proto': 'https' },
    });
  }

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  });
  afterEach(() => {
    if (env.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
    if (env.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.key;
    vi.clearAllMocks();
  });

  it('does not sign out a cookie-carrying user when the auth server is unreachable', async () => {
    getUser.mockResolvedValue({
      user: null,
      error: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError' }),
    });
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/home', { 'sb-example-auth-token': 'stored' }));
    // 200, not a 307 to /login: their session is intact, the network was not.
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('still sends a genuinely signed-out visitor to /login', async () => {
    getUser.mockResolvedValue({ user: null, error: null });
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/home'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('redirect')).toBe('/home');
  });

  it('signs out a user whose refresh token the auth server has actually rejected', async () => {
    // A definitive rejection is NOT covered by the outage exemption, even with
    // cookies present — otherwise a revoked session would never end.
    getUser.mockResolvedValue({
      user: null,
      error: Object.assign(new Error('Invalid Refresh Token: Already Used'), { name: 'AuthApiError', status: 401 }),
    });
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/home', { 'sb-example-auth-token': 'stale' }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/login');
  });

  it('hands a refreshed token to the browser AND to the server render', async () => {
    // The second half is the one that bites: Server Components read the request
    // cookies, so without the write-back they re-spend the refresh token this
    // request just rotated, and reuse detection revokes the whole session.
    const req = request('/home', { 'sb-example-auth-token': 'old' });
    getUser.mockResolvedValue({
      user: { id: 'u1' },
      error: null,
      refreshed: [{ name: 'sb-example-auth-token', value: 'new', options: { path: '/' } }],
    });
    const { middleware } = await import('@/middleware');
    const res = await middleware(req);
    expect(setAllSpy).toHaveBeenCalled();
    expect(res.cookies.get('sb-example-auth-token')?.value).toBe('new');
    expect(req.cookies.get('sb-example-auth-token')?.value).toBe('new');
  });

  it('carries refreshed cookies onto a redirect instead of dropping them', async () => {
    getUser.mockResolvedValue({
      user: null,
      error: null,
      refreshed: [{ name: 'sb-example-auth-token', value: 'rotated', options: { path: '/' } }],
    });
    const { middleware } = await import('@/middleware');
    const res = await middleware(request('/home', { 'sb-example-auth-token': 'old' }));
    expect(res.status).toBe(307);
    expect(res.cookies.get('sb-example-auth-token')?.value).toBe('rotated');
  });
});

describe('sign-out is the only thing that ends a session', () => {
  const signout = readFileSync('app/auth/signout/route.ts', 'utf8');

  it('ends this device only, so the phone stays signed in', () => {
    // supabase-js defaults to `global`, which revokes every refresh token the
    // user holds anywhere — the exact surprise logout this work removes.
    expect(signout).toContain("auth.signOut({ scope })");
    expect(signout).toContain("return 'local'");
    expect(signout).toContain("form.get('scope') === 'global' ? 'global' : 'local'");
  });

  it('expires the auth cookies on the response itself', () => {
    expect(signout).toContain('isAuthCookieName(cookie.name)');
    expect(signout).toContain("res.cookies.set(cookie.name, '', { path: '/', maxAge: 0 })");
  });

  it('is reachable — the route is POST-only, so nothing may link to it', () => {
    // The handler exports POST and nothing else, so `<a href="/auth/signout">`
    // is a GET the route answers 405. That shipped on the trial-paywall and
    // account-closed gates, where the sign-out link is the ONLY way out of a
    // full-screen overlay: a user who wanted to leave simply could not.
    expect(signout).toContain('export async function POST(');
    expect(signout).not.toContain('export async function GET(');

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(path) && /href=["'`]\/auth\/signout/.test(readFileSync(path, 'utf8'))) {
          offenders.push(path);
        }
      }
    };
    for (const dir of ['app', 'components']) walk(dir);
    expect(offenders, 'sign out must be posted, not linked').toEqual([]);
  });
});

describe('the browser holds exactly one auth client', () => {
  const client = readFileSync('lib/supabase/client.ts', 'utf8');

  it('memoizes it, so competing refresh timers cannot spend one token twice', () => {
    expect(client).toContain('client ??= build()');
    expect(client).toContain("if (typeof window === 'undefined') return build();");
  });

  it('states the persistence options rather than inheriting them', () => {
    for (const option of ['persistSession: true', 'autoRefreshToken: true', 'detectSessionInUrl: true']) {
      expect(client, option).toContain(option);
    }
    expect(client).toContain('durableCookieOptions');
  });

  it('is the only regular browser client, apart from the guarded recovery installer', () => {
    // The recovery installer has no automatic refresh or URL detection; its
    // installed-SDK lifecycle/cookie isolation is exercised by auth-recovery-ui.
    // All ordinary app callers must continue using the shared singleton.
    const sources = [
      'components', 'app', 'lib',
    ].flatMap((dir) => walk(dir));
    const offenders = sources.filter((file) => file !== 'lib/supabase/client.ts' && file !== 'components/auth/recovery-form.tsx'
      && readFileSync(file, 'utf8').includes('createBrowserClient'));
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry: string) => {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('the app keeps the session and the server render in step', () => {
  const keeper = readFileSync('components/auth/session-keeper.tsx', 'utf8');
  const layout = readFileSync('app/(app)/layout.tsx', 'utf8');

  it('is mounted for every authenticated route', () => {
    expect(layout).toContain('<SessionKeeper userId={user.id} />');
  });

  it('keeps refreshing while the App Lock screen is up', () => {
    // Otherwise unlocking with the PIN after a long idle lands on /login.
    expect(layout.indexOf('<SessionKeeper userId={user.id} />')).toBeLessThan(layout.indexOf('AppLockGate enabled'));
  });

  it('revives on the events that follow a long absence', () => {
    for (const event of ['visibilitychange', 'focus', 'online', 'pageshow', "'resume'"]) {
      expect(keeper, event).toContain(event);
    }
  });

  it('never clears a session itself — it only re-reads and re-renders', () => {
    expect(keeper).not.toContain('signOut');
    expect(keeper).toContain('router.refresh()');
  });
});
