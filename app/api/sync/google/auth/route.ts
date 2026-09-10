import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { googleAuthUrl, googleSyncRedirectUri, isGoogleSyncConfigured } from '@/lib/sync/providers/google';
import { createSyncOAuthState, syncOAuthStateCookie, syncOAuthStatePath } from '@/lib/sync/oauth-state';
import { startOnboardingCalendarOAuth } from '@/lib/services/onboarding-calendar/oauth';
import { calendarContinuationCookie } from '@/lib/onboarding/calendar-state';

// Starts the app-level Google OAuth flow for two-way sync (calendar + tasks,
// offline access). Distinct from Supabase login: this obtains a persistent
// refresh token stored encrypted in sync_tokens. The redirect URI is derived
// from the request origin so it stays consistent through the token exchange —
// register exactly "<origin>/api/sync/google/callback" in the Google console.
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('onboarding') === '1') return startOnboardingCalendarOAuth(req, 'google');
  await requireUserContext();
  const origin = req.nextUrl.origin;

  if (!isGoogleSyncConfigured()) {
    return NextResponse.redirect(new URL('/dashboard/sync/accounts/google?error=not_configured', origin));
  }

  const redirectUri = googleSyncRedirectUri(origin);
  const state = createSyncOAuthState();
  const response = NextResponse.redirect(googleAuthUrl(redirectUri, state));
  response.cookies.set(calendarContinuationCookie('google'), '', { path: syncOAuthStatePath('google'), maxAge: 0 });
  response.cookies.set(syncOAuthStateCookie('google'), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: syncOAuthStatePath('google'),
    maxAge: 600,
  });
  return response;
}
