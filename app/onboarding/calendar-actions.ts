'use server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { createFamilySchema } from '@/lib/validation';
import { getAdapter } from '@/lib/sync/registry';
import { hasEncryptionKey } from '@/lib/sync/crypto';
import { createSyncOAuthState, syncOAuthStatePath } from '@/lib/sync/oauth-state';
import { calendarContinuationCookie, onboardingCalendarProvider, sealCalendarContinuation } from '@/lib/onboarding/calendar-state';
import { prepareCalendarFamily, verifyCalendarWizard } from '@/lib/services/onboarding-calendar/setup';
import { previewConnectedCalendar } from '@/lib/services/onboarding-calendar';
import { assertOnboardingCalendarAccess } from '@/lib/services/onboarding-calendar/access';
import { buildFirstBrief } from '@/lib/onboarding/first-brief';
import type { ServiceScope } from '@/lib/services/types';

const startSchema = z.object({ provider: onboardingCalendarProvider, family: createFamilySchema,
  displayName: z.string().trim().min(1).max(60) });
export async function startCalendarConnectionAction(input: z.infer<typeof startSchema>) {
  const t = await getTranslations();
  try {
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: t('connectedCalendar.unavailable') };
    const { provider, family, displayName } = parsed.data;
    if (!getAdapter(provider)?.isConfigured() || !hasEncryptionKey()) return { ok: false as const, error: t('connectedCalendar.unavailable') };
    const db = await createServer();
    const auth = await db.auth.getUser();
    if (auth.error || !auth.data.user) return { ok: false as const, error: t('connectedCalendar.unavailable') };
    const scope: ServiceScope = { db: createServiceClient(), familyId: '', userId: auth.data.user.id, role: 'parent', actorKind: 'member', memberId: null, tz: family.timezone };
    await assertOnboardingCalendarAccess(scope);
    const prepared = await prepareCalendarFamily(scope, { ...family, displayName });
    if (!prepared.ok) return prepared;
    await assertOnboardingCalendarAccess({ ...scope, familyId: prepared.data.familyId });
    const state = `onboarding.${createSyncOAuthState()}`;
    (await cookies()).set(calendarContinuationCookie(provider), sealCalendarContinuation({ userId: scope.userId!, familyId: prepared.data.familyId, provider, state }), {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: syncOAuthStatePath(provider), maxAge: 600,
    });
    return { ok: true as const, url: `/api/sync/${provider}/auth?onboarding=1` };
  } catch {
    console.error('[onboarding-calendar] connection action failed');
    return { ok: false as const, error: t('connectedCalendar.unavailable') };
  }
}

export async function previewConnectedCalendarAction(accountId: string) {
  const t = await getTranslations();
  try {
    if (!z.string().uuid().safeParse(accountId).success) return { ok: false as const, error: t('connectedCalendar.unavailable') };
    const db = await createServer();
    const auth = await db.auth.getUser();
    if (auth.error || !auth.data.user) return { ok: false as const, error: t('connectedCalendar.unavailable') };
    const admin = createServiceClient();
    const account = await admin.from('sync_accounts').select('family_id, provider').eq('id', accountId).eq('user_id', auth.data.user.id).maybeSingle();
    if (account.error || !account.data) return { ok: false as const, error: t('connectedCalendar.unavailable') };
    const family = await admin.from('families').select('timezone').eq('id', account.data.family_id).maybeSingle();
    const adapter = getAdapter(account.data.provider);
    if (family.error || !family.data || !adapter?.isConfigured()) return { ok: false as const, error: t('connectedCalendar.unavailable') };
    const scope: ServiceScope = { db: admin, userId: auth.data.user.id, familyId: account.data.family_id,
      actorKind: 'member', role: 'parent', memberId: null, tz: family.data.timezone };
    if (!await verifyCalendarWizard(scope, { allowPendingActivation: true })) return { ok: false as const, error: t('connectedCalendar.unavailable') };
    const result = await previewConnectedCalendar(scope, accountId, adapter);
    if (!result.ok) return result;
    return { ok: true as const, data: { ...result.data, brief: buildFirstBrief(result.data.events, new Date(), [], scope.tz) } };
  } catch {
    console.error('[onboarding-calendar] preview action failed');
    return { ok: false as const, error: t('connectedCalendar.unavailable') };
  }
}
