import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from '@/lib/supabase/server';
import { exchangeGoogleCode, googleCalendarRedirectUri, type GoogleToken } from '@/lib/google';
import { canStoreGoogleToken, encodeGoogleToken } from '@/lib/google-token-storage';

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

    // A PostgREST call RESOLVES with { data, error } — it does not throw — so
    // the catch below cannot see either of these failing. Both are read.
    //
    // The read matters more than it looks. This upsert writes the WHOLE
    // notification_prefs object, so falling back to `{}` on a refused read does
    // not just lose the token: it overwrites every other notification
    // preference this user has set. A transient read failure would quietly
    // reset their settings as a side effect of connecting a calendar.
    const { data: prefs, error: readError } = await supabase
      .from('user_preferences')
      .select('notification_prefs')
      .eq('user_id', userId)
      .maybeSingle();
    if (readError) {
      console.error('Google Calendar callback: preferences read failed', readError);
      return redirect('error');
    }

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
    const existing = (prefs?.notification_prefs as Record<string, unknown>) ?? {};
    const merged = { ...existing, googleCalendarToken: encodeGoogleToken(token) };

    const { error: writeError } = await supabase
      .from('user_preferences')
      .upsert({ user_id: userId, notification_prefs: merged }, { onConflict: 'user_id' });
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
