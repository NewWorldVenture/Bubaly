import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Found by the API sweep of every route on a local production build: a
// signed-in GET of /api/google/calendar/auth — the "Connect Google Calendar"
// link on the calendar page — answered 500 with an empty body wherever
// GOOGLE_CLIENT_ID is unset. `getGoogleOAuthUrl` throws, by design, rather
// than send Google a request it would reject as `Error 400: invalid_request`;
// the route did not catch it, so a person who clicked the link was left on a
// blank error page.
//
// The callback already returns every failure to `/dashboard/calendar?gcal=error`,
// which the calendar page turns into "connection failed". The auth route now
// does the same, and says in the server log which variable is missing.

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: vi.fn(async () => ({ user: { id: 'u' } })) }));

const ORIGIN = 'https://www.bubaly.com';
const saved = process.env.GOOGLE_CLIENT_ID;

function auth() {
  return new NextRequest(`${ORIGIN}/api/google/calendar/auth`, { method: 'GET' });
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  if (saved === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = saved;
  vi.restoreAllMocks();
});

describe('connecting Google Calendar where it is not configured', () => {
  it('returns the person to the calendar with the failure, instead of a blank 500', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const { GET } = await import('@/app/api/google/calendar/auth/route');
    const res = await GET(auth());
    expect(res.status).toBe(307);
    // Merged with #619, which answers this case first and more specifically:
    // the calendar says the connection isn't set up, not that it failed.
    expect(res.headers.get('location')).toBe(`${ORIGIN}/dashboard/calendar?gcal=not_configured`);
    // No half-started flow: nothing to complete, so no state cookie.
    expect(res.headers.get('set-cookie') ?? '').not.toContain('gcal_oauth_state=');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('GOOGLE_CLIENT_ID'));
  });

  it('still sends a configured deployment to Google with a single-use state', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-fixture.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET ??= 'secret-fixture';
    const { GET } = await import('@/app/api/google/calendar/auth/route');
    const res = await GET(auth());
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe('https://accounts.google.com');
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(res.headers.get('set-cookie')).toContain(`gcal_oauth_state=${state}`);
  });
});
