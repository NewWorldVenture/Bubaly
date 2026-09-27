import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { requireUserContext } from '@/lib/supabase/auth';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { dispatchPendingPushes } from '@/lib/server/push';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

export const runtime = 'nodejs';

export async function POST() {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();
    // The page in front of this is feature-gated; this endpoint was not.
    // Same resolver, so the two cannot disagree.
    const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/notifications']);
    if (refused) return refused;
    const limited = await enforceRequestRateLimit(
      supabase,
      `notifications:generate:${ctx.active.familyId}:${ctx.user.id}`,
      { limit: 10 },
    );
    if (!limited.ok) {
      return NextResponse.json(
        { error: t('generate.tooManyNotificationRefreshesPlease') },
        { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
      );
    }
    // Generation is the cron's job run on demand, and it writes the same rows
    // the cron writes: reminders addressed to every member of the family. A
    // member's session may only INSERT notifications addressed to itself
    // (0388), so this runs as the service role, for the caller's own active
    // family (requireUserContext + the entitlement gate above), exactly as the
    // cron does for every family.
    const created = await generateFamilyNotifications(createServiceClient(), ctx.active.familyId);
    // Push delivery needs cross-user device reads → service client, family-scoped.
    try {
      await dispatchPendingPushes(createServiceClient(), { familyId: ctx.active.familyId });
    } catch (e) {
      console.error('Push dispatch failed:', e);
    }
    return NextResponse.json({ created });
  } catch (err) {
    console.error('Notification generate error:', err);
    return NextResponse.json({ error: t('generate.couldNotRefreshNotifications') }, { status: 500 });
  }
}
