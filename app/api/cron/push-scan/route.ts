import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { dispatchPendingPushes } from '@/lib/server/push';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';

// Frequent push scan (every ~2h via Vercel Cron). Regenerates each family's
// "who needs to know" notifications and delivers any un-pushed ones as device
// pushes — but deliberately does NOT run the email digest (that stays on the
// once-daily /api/cron/notifications run so families aren't emailed 8× a day).
//
// Why a second, tighter cron: imminent moments, leave-by nudges, birthdays and
// due family reminders are time-sensitive. On the daily-only run, an event or
// reminder added after 11:00 UTC for later the same day would be missed until
// the next day — after it mattered. Running the push half every couple of hours
// closes that gap while the daily run keeps owning email.
//
// Generation deduplicates by related_id. Delivery uses pushed_at and sent_at;
// overlapping workers or a partial delivery can retry already delivered devices.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('pushScan.unauthorized') }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: families, error } = await supabase.from('families').select('id');
  if (error) {
    console.error('Push-scan cron read failed:', error);
    return NextResponse.json({ error: t('pushScan.pushScanProcessingFailed') }, { status: 500 });
  }

  let created = 0;
  let generationFailures = 0;
  for (const f of families ?? []) {
    try {
      created += await generateFamilyNotifications(supabase, f.id);
    } catch (e) {
      generationFailures += 1;
      console.error(`Notification generation failed for family ${f.id}:`, e);
    }
  }

  let pushed = { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } };
  let pushDispatchFailures = 0;
  try {
    pushed = await dispatchPendingPushes(supabase);
  } catch (e) {
    pushDispatchFailures = 1;
    console.error('Push dispatch failed:', e);
  }

  const failed = generationFailures + pushDispatchFailures + pushed.result.failed + pushed.result.skipped;
  const ok = failed === 0;
  return NextResponse.json(
    { ok, families: families?.length ?? 0, created, pushed, failed },
    { status: ok ? 200 : 502 },
  );
}
