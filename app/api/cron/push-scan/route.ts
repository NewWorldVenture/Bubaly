import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readAll } from '@/lib/supabase/read-all';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { respawnMissingChoreAssignments } from '@/lib/services/tasks';
import { systemScopeForFamily } from '@/lib/services/scope';
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
  // Every household — see lib/supabase/read-all.ts for why an unbounded select
  // silently stops at PostgREST's row ceiling. Every OPEN household: a family
  // that closed its account (families.closed_at) is not nudged on its devices.
  const { rows: families, error } = await readAll<{ id: string }>(
    (from, to) => supabase.from('families').select('id').is('closed_at', null).order('id').range(from, to),
  );
  if (error) {
    console.error('Push-scan cron read failed:', error);
    return NextResponse.json({ error: t('pushScan.pushScanProcessingFailed') }, { status: 500 });
  }

  let created = 0;
  let generationFailures = 0;
  // A recurring chore whose approval could not create its successor (the
  // approval stands; the respawn is logged) would otherwise stop for good. The
  // sweep asks for the successor under the key the approval would have used,
  // so it creates nothing twice. lib/services/tasks `respawnMissingChoreAssignments`.
  let respawned = 0;
  let respawnFailures = 0;
  for (const f of families ?? []) {
    try {
      created += await generateFamilyNotifications(supabase, f.id);
    } catch (e) {
      generationFailures += 1;
      console.error(`Notification generation failed for family ${f.id}:`, e);
    }
    try {
      const scope = await systemScopeForFamily(supabase, f.id);
      const swept = scope ? await respawnMissingChoreAssignments(scope) : null;
      if (!swept || !swept.ok || swept.data.failed > 0) respawnFailures += 1;
      if (swept?.ok) respawned += swept.data.respawned;
    } catch (e) {
      respawnFailures += 1;
      console.error(`Chore respawn sweep failed for family ${f.id}:`, e);
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

  const failed = generationFailures + respawnFailures + pushDispatchFailures + pushed.result.failed + pushed.result.skipped;
  const ok = failed === 0;
  return NextResponse.json(
    { ok, families: families?.length ?? 0, created, respawned, pushed, failed },
    { status: ok ? 200 : 502 },
  );
}
