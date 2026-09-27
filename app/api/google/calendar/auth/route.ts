import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireUserContext } from '@/lib/supabase/auth';
import { getGoogleOAuthUrl } from '@/lib/google';

// Redirects the user to Google's OAuth consent screen (Calendar read scope).
//
// AUTH-1 hardening: the `state` is a random, single-use, OPAQUE CSRF token — it
// carries NO identity. We stash it in an httpOnly cookie and verify it on the
// callback, so a forged callback can't link an attacker's Google account to a
// victim (or vice-versa). The connected user is resolved from the session on the
// callback, never from `state`.
export async function GET(req: NextRequest) {
  await requireUserContext(); // must be signed in; identity comes from the session

  const state = randomBytes(32).toString('base64url');
  let consentUrl: string;
  try {
    consentUrl = getGoogleOAuthUrl(state, req.nextUrl.origin);
  } catch (error) {
    // Not configured here (GOOGLE_CLIENT_ID unset). Hand the person back to the
    // calendar the way the callback hands back every failure, rather than a
    // blank 500, and name the missing variable in the log.
    console.error(`Google Calendar connect: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.redirect(new URL('/dashboard/calendar?gcal=error', req.nextUrl.origin));
  }
  const res = NextResponse.redirect(consentUrl);
  res.cookies.set('gcal_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // sent on the top-level GET redirect back from Google
    path: '/api/google/calendar',
    maxAge: 600, // 10 minutes to complete consent
  });
  return res;
}
