import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getAdapter } from '@/lib/sync/registry';
import { connectAccount } from '@/lib/sync/accounts';
import { hasEncryptionKey } from '@/lib/sync/crypto';
import { syncOAuthStateCookie, syncOAuthStatePath, verifySyncOAuthState } from '@/lib/sync/oauth-state';
import type { SyncProviderEnum } from '@/lib/database.types';
import { finishOnboardingCalendarOAuth } from '@/lib/services/onboarding-calendar/oauth';
import { calendarContinuationCookie } from '@/lib/onboarding/calendar-state';

// Provider-generic OAuth callback (R9): exchanges the code via the registry
// adapter, resolves the account identity, and stores everything (tokens
// AES-256-GCM encrypted) via connectAccount. Fails closed without SYNC_TOKEN_KEY.
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const url = new URL(req.url);
  const origin = req.nextUrl.origin;
  const { provider: raw } = await params;
  if (raw === 'microsoft' && (req.cookies.has(calendarContinuationCookie(raw)) || req.nextUrl.searchParams.get('state')?.startsWith('onboarding.'))) return finishOnboardingCalendarOAuth(req, 'microsoft');
  const provider = raw as SyncProviderEnum;
  const back = (q: string) => NextResponse.redirect(new URL(`/dashboard/sync/accounts/${raw}?${q}`, origin));

  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const stateCookie = syncOAuthStateCookie(raw);
  const cookieState = req.cookies.get(stateCookie)?.value ?? null;

  const adapter = getAdapter(provider);
  const redirect = (q: string) => {
    const response = back(q);
    response.cookies.set(stateCookie, '', { path: syncOAuthStatePath(raw), maxAge: 0 });
    return response;
  };

  if (!adapter || !adapter.isConfigured()) return redirect('error=not_configured');
  if (oauthError || !code || !verifySyncOAuthState(stateRaw, cookieState)) return redirect('error=state_mismatch');
  if (!hasEncryptionKey()) return redirect('error=no_encryption_key');

  try {
    const ctx = await requireUserContext();

    // Must match the auth leg exactly: same env override, same origin fallback.
    const redirectUri = process.env[`${provider.toUpperCase()}_SYNC_REDIRECT_URI`]?.trim()
      || `${origin}/api/sync/${provider}/callback`;
    const tokens = await adapter.exchangeCode(code, redirectUri);
    const identity = await adapter.getAccountIdentity(tokens.accessToken).catch(() => null);

    const admin = createServiceClient();
    await connectAccount(admin, {
      userId: ctx.user.id,
      familyId: ctx.active.familyId,
      provider,
      externalId: identity ?? ctx.user.id,
      displayName: identity,
      scope: tokens.scope ?? null,
      tokens,
    });
    await admin.from('sync_audit_logs').insert({
      user_id: ctx.user.id, family_id: ctx.active.familyId, provider, action: 'connect',
      detail: { identity },
    });

    return redirect('connected=1');
  } catch (err) {
    console.error(`${provider} sync callback error:`, err);
    return redirect('error=connect_failed');
  }
}
