import { NextResponse } from 'next/server';
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
export async function GET() {
  await requireUserContext(); // must be signed in; identity comes from the session

  const state = randomBytes(32).toString('base64url');
  const res = NextResponse.redirect(getGoogleOAuthUrl(state));
  res.cookies.set('gcal_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // sent on the top-level GET redirect back from Google
    path: '/api/google/calendar',
    maxAge: 600, // 10 minutes to complete consent
  });
  return res;
}
