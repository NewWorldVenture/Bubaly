import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The calendar callback's error path built its redirect from
// `process.env.NEXT_PUBLIC_APP_URL ?? ''`. With that variable unset the target
// collapses to the RELATIVE string `/dashboard/calendar?gcal=error`, and
// `NextResponse.redirect` requires an absolute URL — it throws `Invalid URL`.
//
// So the one path whose whole job is to hand a failure back to the user gently
// was the path that crashed: a user who declined consent, or arrived with a
// stale `state`, got a 500 instead of being returned to the calendar page.
// Every exit from this route is that redirect, including the success one.
//
// `req.nextUrl.origin` is always populated and needs no configuration, which is
// what the neighbouring sync callbacks already use.

vi.mock('@/lib/supabase/server', () => ({ createServer: vi.fn() }));
vi.mock('@/lib/google', () => ({ exchangeGoogleCode: vi.fn() }));

const ORIGIN = 'https://www.bubaly.com';
const saved = process.env.NEXT_PUBLIC_APP_URL;

function callback(query: string, cookie?: string) {
  return new NextRequest(`${ORIGIN}/api/google/calendar/callback${query}`, {
    method: 'GET',
    headers: cookie ? { cookie } : undefined,
  });
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = saved;
  vi.restoreAllMocks();
});

describe('the calendar callback returns the user to the app when it cannot connect', () => {
  // The regression: this threw rather than redirecting.
  it.each([
    ['the user declined consent at Google', '?error=access_denied&state=s'],
    ['no code came back', '?state=s'],
    ['no state came back', '?code=c'],
    ['the state does not match the cookie', '?code=c&state=forged'],
  ])('redirects instead of throwing when %s', async (_case, query) => {
    const { GET } = await import('@/app/api/google/calendar/callback/route');

    const res = await GET(callback(query, 'gcal_oauth_state=issued'));

    expect([302, 307, 308]).toContain(res.status);
    const location = res.headers.get('location');
    expect(location).toBeTruthy();
    // Absolute, and on the origin the request actually arrived at — the property
    // the empty-string base destroyed.
    expect(() => new URL(location as string)).not.toThrow();
    expect(new URL(location as string).origin).toBe(ORIGIN);
    expect(new URL(location as string).pathname).toBe('/dashboard/calendar');
    expect(new URL(location as string).searchParams.get('gcal')).toBe('error');
  });

  // The single-use CSRF cookie must still be spent on the way out; the redirect
  // is what carries that clearing header, so a throw dropped it too.
  it('still clears the single-use state cookie', async () => {
    const { GET } = await import('@/app/api/google/calendar/callback/route');

    const res = await GET(callback('?error=access_denied&state=s', 'gcal_oauth_state=issued'));

    const cleared = res.cookies.get('gcal_oauth_state');
    expect(cleared?.value).toBe('');
    expect(cleared?.maxAge).toBe(0);
  });

  // Configuration must not be able to reintroduce the crash: a deployment that
  // sets the variable to something unusable is no longer consulted at all.
  it('ignores NEXT_PUBLIC_APP_URL entirely, however it is set', async () => {
    for (const value of ['', '   ', 'not-a-url']) {
      process.env.NEXT_PUBLIC_APP_URL = value;
      const { GET } = await import('@/app/api/google/calendar/callback/route');

      const res = await GET(callback('?error=access_denied&state=s', 'gcal_oauth_state=issued'));

      expect(new URL(res.headers.get('location') as string).origin).toBe(ORIGIN);
    }
  });
});
