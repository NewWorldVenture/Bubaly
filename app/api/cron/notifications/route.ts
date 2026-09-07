import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { dispatchPendingPushes } from '@/lib/server/push';
import { deliverNotificationEmails } from '@/lib/server/notification-emails';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { deliverMorningBriefs } from '@/lib/briefing/deliver';
import { expireStale, remindPendingApprovals } from '@/lib/services/approvals';

export const runtime = 'nodejs';

// Runs a few times a day via Vercel Cron. Generates "who needs to know"
// notifications for every family, then delivers them across both channels:
// a push to each device (gated on pushed_at) and an email digest of each
// member's pending notifications (gated on sent_at). The two channels track
// their own delivery columns, so every notification can be BOTH pushed and
// emailed without one starving the other.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('notifications.unauthorized') }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: families, error } = await supabase.from('families').select('id');
  if (error) {
    console.error('Notification cron read failed:', error);
    return NextResponse.json({ error: t('notifications.notificationProcessingFailed') }, { status: 500 });
  }

  let total = 0;
  let generationFailures = 0;
  for (const f of families ?? []) {
    try {
      total += await generateFamilyNotifications(supabase, f.id);
    } catch (e) {
      generationFailures += 1;
      console.error(`Notification generation failed for family ${f.id}:`, e);
    }
  }

  // AI approvals (0251): expire the ones nobody answered so their runs stop
  // honestly, then remind each manager once about the ones still open. Both
  // run before push dispatch so the reminders ride the same tick's pushes.
  // A sweep failure counts as a generation failure: the reminders it would
  // have produced are notifications this tick did not generate.
  let approvals = { expired: 0, blockedRuns: 0, reminded: 0, remindedFamilies: 0 };
  try {
    const swept = await expireStale(supabase);
    const reminded = await remindPendingApprovals(supabase);
    approvals = { ...swept, reminded: reminded.reminded, remindedFamilies: reminded.families };
  } catch (e) {
    generationFailures += 1;
    console.error('Approval expiry/reminder sweep failed:', e);
  }

  // The morning brief (§49): one notification per family per family-local
  // day, to the managers, with the headline and what needs deciding. Filed
  // before push dispatch so it rides this tick's pushes; a family it failed
  // for is a notification this tick did not generate, and is counted as one.
  let briefs = { delivered: 0, families: 0, skipped: 0, failed: 0 };
  try {
    briefs = await deliverMorningBriefs(supabase);
    generationFailures += briefs.failed;
  } catch (e) {
    generationFailures += 1;
    console.error('Morning brief delivery failed:', e);
  }

  // Deliver pushes for any un-pushed notifications across all families.
  let pushed = { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0 } };
  let pushDispatchFailures = 0;
  try {
    pushed = await dispatchPendingPushes(supabase);
  } catch (e) {
    pushDispatchFailures = 1;
    console.error('Push dispatch failed:', e);
  }

  // Email digests across all families (respects the per-user email toggle and
  // marks rows sent so they aren't re-emailed).
  let emailed = { sent: 0, failed: 0, skipped: 0 };
  let emailDeliveryFailures = 0;
  try {
    emailed = await deliverNotificationEmails(supabase);
  } catch (e) {
    emailDeliveryFailures = 1;
    console.error('Notification email delivery failed:', e);
  }

  const failed = generationFailures + pushDispatchFailures + pushed.result.failed + emailDeliveryFailures + emailed.failed;
  const ok = failed === 0;
  return NextResponse.json(
    { ok, families: families?.length ?? 0, created: total, approvals, briefs, pushed, emailed: emailed.sent, emailFailures: emailed.failed, emailSkipped: emailed.skipped, failed },
    { status: ok ? 200 : 502 },
  );
}
