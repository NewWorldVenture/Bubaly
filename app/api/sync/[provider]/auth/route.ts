import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { getAdapter } from '@/lib/sync/registry';
import { createSyncOAuthState, syncOAuthStateCookie, syncOAuthStatePath } from '@/lib/sync/oauth-state';
import type { SyncProviderEnum } from '@/lib/database.types';
import { startOnboardingCalendarOAuth } from '@/lib/services/onboarding-calendar/oauth';
import { calendarContinuationCookie } from '@/lib/onboarding/calendar-state';

// Provider-generic OAuth start (R9): resolves the adapter from the registry and
// redirects to its consent screen — Microsoft works today, future adapters plug
// in with zero route changes. (Google keeps its original static routes; Next
// prefers static segments, so /api/sync/google/auth is unaffected.)
// Register "<origin>/api/sync/<provider>/callback" in the provider's console.
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const origin = req.nextUrl.origin;
  const { provider: raw } = await params;
  if (raw === 'microsoft' && req.nextUrl.searchParams.get('onboarding') === '1') return startOnboardingCalendarOAuth(req, 'microsoft');
  await requireUserContext();
  const provider = raw as SyncProviderEnum;

  const adapter = getAdapter(provider);
  if (!adapter) {
    return NextResponse.redirect(new URL(`/dashboard/sync/accounts/${raw}?error=not_configured`, origin));
  }
  if (!adapter.isConfigured()) {
    return NextResponse.redirect(new URL(`/dashboard/sync/accounts/${raw}?error=not_configured`, origin));
  }

  // Env override (e.g. MICROSOFT_SYNC_REDIRECT_URI) wins — needed when the app
  // sits behind a proxy/custom domain; otherwise derive from the request origin.
  const redirectUri = process.env[`${provider.toUpperCase()}_SYNC_REDIRECT_URI`]?.trim()
    || `${origin}/api/sync/${provider}/callback`;
  // State is opaque and browser-bound; identity is always derived from the
  // callback session rather than from a caller-controlled query parameter.
  const state = createSyncOAuthState();
  const response = NextResponse.redirect(adapter.authUrl(redirectUri, state));
  response.cookies.set(calendarContinuationCookie(provider), '', { path: syncOAuthStatePath(provider), maxAge: 0 });
  response.cookies.set(syncOAuthStateCookie(provider), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: syncOAuthStatePath(provider),
    maxAge: 600,
  });
  return response;
}
