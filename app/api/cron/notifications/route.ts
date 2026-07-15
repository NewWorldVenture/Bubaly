import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { dispatchPendingPushes } from '@/lib/server/push';
import { deliverNotificationEmails } from '@/lib/server/notification-emails';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';

// Runs a few times a day via Vercel Cron. Generates "who needs to know"
// notifications for every family, then delivers them across both channels:
// a push to each device (gated on pushed_at) and an email digest of each
// member's pending notifications (gated on sent_at). The two channels track
// their own delivery columns, so every notification can be BOTH pushed and
// emailed without one starving the other.
export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: families, error } = await supabase.from('families').select('id');
  if (error) {
    console.error('Notification cron read failed:', error);
    return NextResponse.json({ error: 'Notification processing failed.' }, { status: 500 });
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
    { ok, families: families?.length ?? 0, created: total, pushed, emailed: emailed.sent, emailFailures: emailed.failed, emailSkipped: emailed.skipped, failed },
    { status: ok ? 200 : 502 },
  );
}
