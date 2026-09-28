import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireUserContext } from '@/lib/supabase/auth';
import { getGoogleOAuthUrl, googleClientId, googleClientSecret } from '@/lib/google';

// Redirects the user to Google's OAuth consent screen (Calendar read scope).
//
// AUTH-1 hardening: the `state` is a random, single-use, OPAQUE CSRF token — it
// carries NO identity. We stash it in an httpOnly cookie and verify it on the
// callback, so a forged callback can't link an attacker's Google account to a
// victim (or vice-versa). The connected user is resolved from the session on the
// callback, never from `state`.
export async function GET(req: NextRequest) {
  await requireUserContext(); // must be signed in; identity comes from the session

  // Without both credentials Google refuses the consent request, and letting
  // getGoogleOAuthUrl's error escape left the parent on a blank 500 page. Hand
  // them back to the calendar, which says the connection isn't set up — the
  // same answer the Outlook link beside it gives (/api/sync/[provider]/auth).
  if (!googleClientId() || !googleClientSecret()) {
    console.error(`Google Calendar connect: ${googleClientId() ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID'} is not set, so the consent request would be refused.`);
    return NextResponse.redirect(new URL('/dashboard/calendar?gcal=not_configured', req.nextUrl.origin));
  }

  const state = randomBytes(32).toString('base64url');
  const res = NextResponse.redirect(getGoogleOAuthUrl(state, req.nextUrl.origin));
  res.cookies.set('gcal_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // sent on the top-level GET redirect back from Google
    path: '/api/google/calendar',
    maxAge: 600, // 10 minutes to complete consent
  });
  return res;
}
