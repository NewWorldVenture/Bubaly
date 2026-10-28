import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from '@/lib/supabase/server';
import { exchangeGoogleCode, googleCalendarRedirectUri, type GoogleToken } from '@/lib/google';
import { canStoreGoogleToken, encodeGoogleToken } from '@/lib/google-token-storage';
import { mergeNotificationPrefs } from '@/lib/preferences/notification-prefs';

// Google redirects here after the user grants calendar access. Exchanges the code
// for tokens and stores them on the SESSION user's user_preferences.
//
// AUTH-1 hardening: verify the `state` param against the single-use httpOnly
// cookie set at auth time (CSRF), and derive the connected user from the session
// (`getUser`) — NEVER from `state`. This closes the calendar-link hijack where a
// forged callback could attach a Google account to an arbitrary userId.

const STATE_COOKIE = 'gcal_oauth_state';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');
  const cookieState = req.cookies.get(STATE_COOKIE)?.value ?? null;

  // The request's own origin, like the sync callbacks use: always populated, so
  // it cannot collapse to a relative URL the way an unset NEXT_PUBLIC_APP_URL
  // did — NextResponse.redirect throws on those, and EVERY exit here is this
  // redirect, so a missing variable turned the whole route into a 500.
  const origin = req.nextUrl.origin;
  // Always clear the single-use state cookie on the way out.
  const redirect = (status: 'connected' | 'error') => {
    const res = NextResponse.redirect(new URL(`/dashboard/calendar?gcal=${status}`, origin));
    res.cookies.set(STATE_COOKIE, '', { path: '/api/google/calendar', maxAge: 0 });
    return res;
  };

  // CSRF: the callback state must match the cookie we issued at auth time.
  if (errorParam || !code || !state || !cookieState || !safeEqual(state, cookieState)) {
    return redirect('error');
  }

  try {
    const supabase = await createServer();
    // Identity comes from the session, never from `state`.
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) return redirect('error');

    // Same origin the consent request was built from, so the two redirect_uri
    // values Google compares are produced by one function, not two.
    const token: GoogleToken = await exchangeGoogleCode(code, googleCalendarRedirectUri(origin));

    // Encrypted before it touches the column, because this row's policies are
    // `user_id = auth.uid()` for SELECT as well as UPDATE — the browser can
    // read it. Fail closed if there is no key: a connection that silently
    // stores a refresh token in the clear is worse than one that did not
    // connect, and the failure is loud here rather than invisible forever.
    // Audit C3-S5-02.
    if (!canStoreGoogleToken()) {
      console.error('Google Calendar callback: SYNC_TOKEN_KEY is not set, refusing to store a token in plaintext');
      return redirect('error');
    }
    // Only the token changes, merged onto the row as it is at write time, with
    // a compare-and-set (SRV-001 l7). A PostgREST call RESOLVES with
    // { data, error } rather than throwing, so the catch below cannot see a
    // failure; mergeNotificationPrefs reads both. A read that failed writes
    // nothing: merging into `{}` would overwrite every other preference this
    // user has set as a side effect of connecting a calendar.
    const written = await mergeNotificationPrefs(supabase, userId,
      (prefs) => ({ ...prefs, googleCalendarToken: encodeGoogleToken(token) }));
    if (!written.ok && written.reason === 'read_failed') {
      console.error('Google Calendar callback: preferences read failed', written.error);
      return redirect('error');
    }
    const writeError = written.ok ? null : (written.error ?? written.reason);
    if (writeError) {
      // Without this the user is told the calendar is connected while no token
      // was stored — every later sync then fails for a reason the screen denies.
      console.error('Google Calendar callback: token write failed', writeError);
      return redirect('error');
    }

    return redirect('connected');
  } catch (err) {
    console.error('Google Calendar callback error:', err);
    return redirect('error');
  }
}
