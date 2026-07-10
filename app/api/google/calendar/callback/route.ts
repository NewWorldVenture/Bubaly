import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from '@/lib/supabase/server';
import { exchangeGoogleCode, type GoogleToken } from '@/lib/google';

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

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  // Always clear the single-use state cookie on the way out.
  const redirect = (status: 'connected' | 'error') => {
    const res = NextResponse.redirect(`${appUrl}/dashboard/calendar?gcal=${status}`);
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

    const token: GoogleToken = await exchangeGoogleCode(code);

    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('notification_prefs')
      .eq('user_id', userId)
      .maybeSingle();

    const existing = (prefs?.notification_prefs as Record<string, unknown>) ?? {};
    const merged = { ...existing, googleCalendarToken: token };

    await supabase
      .from('user_preferences')
      .upsert({ user_id: userId, notification_prefs: merged }, { onConflict: 'user_id' });

    return redirect('connected');
  } catch (err) {
    console.error('Google Calendar callback error:', err);
    return redirect('error');
  }
}
