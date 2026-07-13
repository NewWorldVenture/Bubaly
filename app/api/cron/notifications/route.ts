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
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let total = 0;
  for (const f of families ?? []) {
    try {
      total += await generateFamilyNotifications(supabase, f.id);
    } catch (e) {
      console.error(`Notification generation failed for family ${f.id}:`, e);
    }
  }

  // Deliver pushes for any un-pushed notifications across all families.
  let pushed = { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0 } };
  try {
    pushed = await dispatchPendingPushes(supabase);
  } catch (e) {
    console.error('Push dispatch failed:', e);
  }

  // Email digests across all families (respects the per-user email toggle and
  // marks rows sent so they aren't re-emailed).
  let emailed = 0;
  try {
    emailed = await deliverNotificationEmails(supabase);
  } catch (e) {
    console.error('Notification email delivery failed:', e);
  }

  return NextResponse.json({ families: families?.length ?? 0, created: total, pushed, emailed });
}
