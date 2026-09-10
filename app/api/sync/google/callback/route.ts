import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { exchangeCode, getGoogleUserEmail, googleSyncRedirectUri } from '@/lib/sync/providers/google';
import { connectAccount } from '@/lib/sync/accounts';
import { hasEncryptionKey } from '@/lib/sync/crypto';
import { syncOAuthStateCookie, syncOAuthStatePath, verifySyncOAuthState } from '@/lib/sync/oauth-state';
import { finishOnboardingCalendarOAuth } from '@/lib/services/onboarding-calendar/oauth';
import { calendarContinuationCookie } from '@/lib/onboarding/calendar-state';

// Google redirects here after consent. Exchanges the code for tokens, fetches the
// account email, and stores everything (tokens AES-256-GCM encrypted) via
// connectAccount. Fails closed if SYNC_TOKEN_KEY is missing.
export async function GET(req: NextRequest) {
  if (req.cookies.has(calendarContinuationCookie('google')) || req.nextUrl.searchParams.get('state')?.startsWith('onboarding.')) return finishOnboardingCalendarOAuth(req, 'google');
  const url = new URL(req.url);
  const origin = req.nextUrl.origin;
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const stateCookie = syncOAuthStateCookie('google');
  const cookieState = req.cookies.get(stateCookie)?.value ?? null;
  const back = (q: string) => NextResponse.redirect(new URL(`/dashboard/sync/accounts/google?${q}`, origin));
  const redirect = (q: string) => {
    const response = back(q);
    response.cookies.set(stateCookie, '', { path: syncOAuthStatePath('google'), maxAge: 0 });
    return response;
  };

  if (oauthError || !code || !verifySyncOAuthState(stateRaw, cookieState)) return redirect('error=state_mismatch');
  if (!hasEncryptionKey()) return redirect('error=no_encryption_key');

  try {
    const ctx = await requireUserContext();

    const redirectUri = googleSyncRedirectUri(origin);
    const tokens = await exchangeCode(code, redirectUri);
    const email = await getGoogleUserEmail(tokens.accessToken);

    const admin = createServiceClient();
    await connectAccount(admin, {
      userId: ctx.user.id,
      familyId: ctx.active.familyId,
      provider: 'google',
      externalId: email ?? ctx.user.id,
      displayName: email,
      scope: tokens.scope ?? null,
      tokens,
    });
    await admin.from('sync_audit_logs').insert({
      user_id: ctx.user.id, family_id: ctx.active.familyId, provider: 'google', action: 'connect',
      detail: { email },
    });

    return redirect('connected=1');
  } catch (err) {
    console.error('Google sync callback error:', err);
    return redirect('error=connect_failed');
  }
}
