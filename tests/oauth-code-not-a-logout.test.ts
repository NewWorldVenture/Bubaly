import { describe, expect, it } from 'vitest';
import {
  hasPkceVerifierCookie,
  isPkceVerifierCookieName,
  shouldForwardAuthCode,
} from '@/lib/auth/session';

// `code` is the STANDARD OAuth parameter name, not Supabase's private one, so
// "a code arrived, it must be a sign-in" is wrong in this app more often than
// it is right. Three provider callbacks receive one — Google Calendar and the
// two sync routes — and each performs its own exchange.
//
// The failure it produced was a logout, not a broken feature. A signed-in user
// connecting their calendar came back to /api/google/calendar/callback?code=…,
// was redirected to /auth/callback, and exchangeCodeForSession was handed a
// GOOGLE code it cannot use — so the route fell through to its last line,
// `/login?error=auth`. The user connected a calendar and got a login page. The
// single-use `state` cookie was spent by then, so trying again failed too.
const VERIFIER = 'sb-ltcxlbipiihclxwioyqj-auth-token-code-verifier';
const SESSION = 'sb-ltcxlbipiihclxwioyqj-auth-token';

describe('a code that is not ours must not end a session', () => {
  // The regression, named by its route.
  it.each([
    '/api/google/calendar/callback',
    '/api/sync/google/callback',
    '/api/sync/outlook/callback',
  ])('leaves %s to do its own exchange', (path) => {
    expect(
      shouldForwardAuthCode({ path, hasCode: true, cookieNames: [SESSION] }),
    ).toBe(false);
  });

  // Even mid-sign-in, an /api/ callback is never Supabase's to answer.
  it('does not capture a provider callback just because a sign-in is in flight', () => {
    expect(
      shouldForwardAuthCode({
        path: '/api/google/calendar/callback',
        hasCode: true,
        cookieNames: [SESSION, VERIFIER],
      }),
    ).toBe(false);
  });

  // A promo or referral link is the other way a signed-in reader met /login.
  it('leaves a marketing code on a marketing page alone', () => {
    expect(
      shouldForwardAuthCode({ path: '/pricing', hasCode: true, cookieNames: [SESSION] }),
    ).toBe(false);
  });

  // What the forward exists for: Supabase's Site URL is a path that does not
  // handle the exchange, and the browser IS mid-PKCE.
  it('still rescues a real Supabase code that landed on the wrong path', () => {
    expect(
      shouldForwardAuthCode({ path: '/', hasCode: true, cookieNames: [VERIFIER] }),
    ).toBe(true);
    expect(
      shouldForwardAuthCode({ path: '/login', hasCode: true, cookieNames: [VERIFIER, SESSION] }),
    ).toBe(true);
  });

  it('does not forward the callback onto itself, or a request with no code', () => {
    expect(
      shouldForwardAuthCode({ path: '/auth/callback', hasCode: true, cookieNames: [VERIFIER] }),
    ).toBe(false);
    expect(
      shouldForwardAuthCode({ path: '/', hasCode: false, cookieNames: [VERIFIER] }),
    ).toBe(false);
  });
});

describe('recognising a sign-in in flight', () => {
  it('matches the PKCE verifier and its chunks', () => {
    expect(isPkceVerifierCookieName(VERIFIER)).toBe(true);
    expect(isPkceVerifierCookieName(`${VERIFIER}.0`)).toBe(true);
    expect(hasPkceVerifierCookie(['other', `${VERIFIER}.1`])).toBe(true);
  });

  // The stored session and the half-finished sign-in are different states, and
  // lib/auth/session keeps them apart on purpose: hasAuthCookies must not see a
  // verifier as a session, and this must not see a session as a sign-in.
  it('is not the session cookie, and the session cookie is not it', () => {
    expect(isPkceVerifierCookieName(SESSION)).toBe(false);
    expect(isPkceVerifierCookieName(`${SESSION}.0`)).toBe(false);
    expect(hasPkceVerifierCookie([SESSION, `${SESSION}.0`])).toBe(false);
  });
});
