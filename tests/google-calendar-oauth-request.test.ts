import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGoogleOAuthUrl, googleCalendarRedirectUri } from '@/lib/google';

// Reported from production, on the consent screen itself:
//
//   Access blocked: Authorization Error
//   You can't sign in to this app because it doesn't comply with Google's
//   OAuth 2.0 policy for keeping apps secure.
//   Error 400: invalid_request
//
// The request never reached a callback, so none of the callback hardening could
// have helped. `lib/google.ts` built the redirect_uri as
// `${process.env.NEXT_PUBLIC_APP_URL}/api/google/calendar/callback` with no
// fallback — the only two sites in the codebase interpolating that variable
// bare; every other one has `?? ''` or a real default. Unset, the parameter
// Google receives is the literal string:
//
//   redirect_uri=undefined%2Fapi%2Fgoogle%2Fcalendar%2Fcallback
//
// which is not an absolute URI, and Google rejects the whole request. The same
// shape applied to `client_id: process.env.GOOGLE_CLIENT_ID!` — "undefined"
// reaches Google and comes back as the same opaque Error 400.
const ORIGIN = 'https://www.bubaly.com';
const saved = {
  app: process.env.NEXT_PUBLIC_APP_URL,
  client: process.env.GOOGLE_CLIENT_ID,
  override: process.env.GOOGLE_CALENDAR_REDIRECT_URI,
};

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  process.env.GOOGLE_CLIENT_ID = 'client-fixture.apps.googleusercontent.com';
});

afterEach(() => {
  restore('NEXT_PUBLIC_APP_URL', saved.app);
  restore('GOOGLE_CLIENT_ID', saved.client);
  restore('GOOGLE_CALENDAR_REDIRECT_URI', saved.override);
});

describe('the Google consent request is always well formed', () => {
  // The regression, stated as the string Google actually received.
  it('never sends a redirect_uri built from an undefined app URL', () => {
    const uri = googleCalendarRedirectUri(ORIGIN);
    expect(uri).not.toContain('undefined');
    expect(() => new URL(uri)).not.toThrow();
    expect(new URL(uri).origin).toBe(ORIGIN);
    expect(new URL(uri).pathname).toBe('/api/google/calendar/callback');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['not a URL', 'bubaly.com'],
  ])('falls back to the request origin when NEXT_PUBLIC_APP_URL is %s', (_case, value) => {
    if (value === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = value;
    expect(googleCalendarRedirectUri(ORIGIN)).toBe(`${ORIGIN}/api/google/calendar/callback`);
  });

  // When it IS configured, that value still wins: it is what is registered in
  // the Google Cloud console, and the request origin need not match it.
  it('prefers the configured app URL, trailing slash and all', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.bubaly.com/';
    expect(googleCalendarRedirectUri('https://preview.vercel.app'))
      .toBe('https://app.bubaly.com/api/google/calendar/callback');
  });

  it('lets an explicit override win over both', () => {
    process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'https://registered.example/cb';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.bubaly.com';
    expect(googleCalendarRedirectUri(ORIGIN)).toBe('https://registered.example/cb');
  });

  it('builds a consent URL Google can parse', () => {
    const url = new URL(getGoogleOAuthUrl('state-token', ORIGIN));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/google/calendar/callback`);
    expect(url.searchParams.get('client_id')).toBe('client-fixture.apps.googleusercontent.com');
    expect(url.searchParams.get('state')).toBe('state-token');
    expect(url.searchParams.get('response_type')).toBe('code');
    // Nothing anywhere in the query may read "undefined".
    expect(url.search).not.toContain('undefined');
  });

  // A missing client id produced the SAME opaque Error 400 as a bad
  // redirect_uri, which is why this took a screenshot to diagnose. Name it.
  it('refuses to send a request with no client id, and says which variable', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => getGoogleOAuthUrl('s', ORIGIN)).toThrow(/GOOGLE_CLIENT_ID/);
    process.env.GOOGLE_CLIENT_ID = '   ';
    expect(() => getGoogleOAuthUrl('s', ORIGIN)).toThrow(/GOOGLE_CLIENT_ID/);
  });

  // Google compares the redirect_uri on the exchange against the one on the
  // consent request and rejects a mismatch. One function, so they cannot drift.
  it('gives the exchange the identical value the consent request used', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.bubaly.com';
    const consent = new URL(getGoogleOAuthUrl('s', ORIGIN)).searchParams.get('redirect_uri');
    expect(consent).toBe(googleCalendarRedirectUri(ORIGIN));
  });
});
