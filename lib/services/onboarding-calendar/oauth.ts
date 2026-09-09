import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getAdapter } from '@/lib/sync/registry';
import { connectAccount } from '@/lib/sync/accounts';
import { hasEncryptionKey } from '@/lib/sync/crypto';
import { googleCalendarReadAuthUrl, googleSyncRedirectUri, exchangeCode } from '@/lib/sync/providers/google';
import { microsoftCalendarReadAuthUrl, microsoftRedirectUri, exchangeMicrosoftCalendarReadCode } from '@/lib/sync/providers/microsoft';
import { syncOAuthStateCookie, syncOAuthStatePath, verifySyncOAuthState } from '@/lib/sync/oauth-state';
import { calendarContinuationCookie, readCalendarContinuation, type CalendarContinuation, type OnboardingCalendarProvider } from '@/lib/onboarding/calendar-state';
import { verifyCalendarWizard } from './setup';
import { assertOnboardingCalendarAccess } from './access';
import type { ServiceScope } from '@/lib/services/types';

function back(req: NextRequest, provider: OnboardingCalendarProvider, status: string, accountId?: string) {
  const url = new URL('/onboarding', req.nextUrl.origin);
  url.searchParams.set('calendarStatus', status);
  if (accountId) url.searchParams.set('calendarAccount', accountId);
  const response = NextResponse.redirect(url);
  for (const name of [calendarContinuationCookie(provider), syncOAuthStateCookie(provider)]) {
    response.cookies.set(name, '', { path: syncOAuthStatePath(provider), maxAge: 0 });
  }
  return response;
}
async function wizardScope(continuation: CalendarContinuation): Promise<ServiceScope | null> {
  const db = await createServer();
  const { data: auth, error } = await db.auth.getUser();
  if (error || auth.user?.id !== continuation.userId) return null;
  const admin = createServiceClient();
  const family = await admin.from('families').select('timezone').eq('id', continuation.familyId).maybeSingle();
  if (family.error || !family.data) return null;
  const scope: ServiceScope = { db: admin, familyId: continuation.familyId, userId: auth.user.id,
    actorKind: 'member', role: 'parent', memberId: null, tz: family.data.timezone };
  if (!await verifyCalendarWizard(scope)) return null;
  await assertOnboardingCalendarAccess(scope);
  return scope;
}

export async function startOnboardingCalendarOAuth(req: NextRequest, provider: OnboardingCalendarProvider): Promise<NextResponse> {
  try {
    const continuation = readCalendarContinuation(req.cookies.get(calendarContinuationCookie(provider))?.value);
    const adapter = getAdapter(provider);
    if (!continuation || continuation.provider !== provider || !adapter?.isConfigured() || !hasEncryptionKey() || !await wizardScope(continuation)) return back(req, provider, 'unavailable');
    const redirectUri = provider === 'google' ? googleSyncRedirectUri(req.nextUrl.origin) : microsoftRedirectUri(req.nextUrl.origin);
    const authUrl = provider === 'google' ? googleCalendarReadAuthUrl(redirectUri, continuation.state) : microsoftCalendarReadAuthUrl(redirectUri, continuation.state);
    const response = NextResponse.redirect(authUrl);
    response.cookies.set(syncOAuthStateCookie(provider), continuation.state, { httpOnly: true,
      secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: syncOAuthStatePath(provider), maxAge: 600 });
    return response;
  } catch {
    console.error('[onboarding-calendar] OAuth preparation failed');
    return back(req, provider, 'unavailable');
  }
}

export async function finishOnboardingCalendarOAuth(req: NextRequest, provider: OnboardingCalendarProvider): Promise<NextResponse> {
  try {
    const continuation = readCalendarContinuation(req.cookies.get(calendarContinuationCookie(provider))?.value);
    const state = req.nextUrl.searchParams.get('state');
    const code = req.nextUrl.searchParams.get('code');
    const adapter = getAdapter(provider);
    if (!continuation || continuation.provider !== provider || !verifySyncOAuthState(state, continuation.state) ||
      !verifySyncOAuthState(state, req.cookies.get(syncOAuthStateCookie(provider))?.value) || !adapter?.isConfigured() || !hasEncryptionKey()) return back(req, provider, 'unavailable');
    if (req.nextUrl.searchParams.get('error')) return back(req, provider, 'cancelled');
    if (!code) return back(req, provider, 'unavailable');
    const scope = await wizardScope(continuation);
    if (!scope) return back(req, provider, 'unavailable');
    const redirectUri = provider === 'google' ? googleSyncRedirectUri(req.nextUrl.origin) : microsoftRedirectUri(req.nextUrl.origin);
    const tokens = provider === 'google' ? await exchangeCode(code, redirectUri) : await exchangeMicrosoftCalendarReadCode(code, redirectUri);
    const identity = await adapter.getAccountIdentity(tokens.accessToken);
    if (!identity || !await verifyCalendarWizard(scope)) return back(req, provider, 'unavailable');
    await assertOnboardingCalendarAccess(scope);
    const accountId = await connectAccount(scope.db, { userId: scope.userId!, familyId: scope.familyId,
      provider, externalId: identity, displayName: identity, tokens, scope: tokens.scope, onboardingCalendar: true });
    const audit = await scope.db.from('sync_audit_logs').insert({ user_id: scope.userId, family_id: scope.familyId,
      provider, action: 'connect', detail: { onboarding: true, direction: 'manual' } });
    if (audit.error) throw new Error('Calendar connection receipt unavailable');
    return back(req, provider, 'connected', accountId);
  } catch {
    console.error('[onboarding-calendar] OAuth connection failed');
    return back(req, provider, 'unavailable');
  }
}
