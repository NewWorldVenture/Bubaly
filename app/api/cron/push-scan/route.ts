import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readAll } from '@/lib/supabase/read-all';
import { generateFamilyNotifications, type NotificationGenerationReport } from '@/lib/server/notifications';
import { respawnMissingChoreAssignments } from '@/lib/services/tasks';
import { systemScopeForFamily } from '@/lib/services/scope';
import { dispatchPendingPushes } from '@/lib/server/push';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { sweepFamilies } from '@/lib/server/cron-family-sweep';
import { claimGenerationLease } from '@/lib/server/notification-generation-lease';
import { lastDailySlot, PUSH_SCAN_SLOTS } from '@/lib/server/cron-slot';

export const runtime = 'nodejs';
// Inside the dispatcher's 120 s abort (scripts/cron-dispatch.mjs), which is
// what calls this route every two hours; chosen rather than inherited.
export const maxDuration = 120;
// Generation and the chore respawn stop STARTING families once this much is
// spent, so push dispatch (PUSH_DISPATCH_BUDGET_MS, 45 s) always runs for the
// rows already queued: the imminent-moment nudges this cron exists for were
// delivered to nobody when the loop above them ran the function into its limit.
const GENERATION_BUDGET_MS = 60_000;
// One family's reads outliving this are that family's failure, not the run's.
const FAMILY_TIMEOUT_MS = 15_000;
const FAMILY_CONCURRENCY = 4;

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
  // Families another generator holds right now (the daily notifications run on
  // its mirrored minute, a member's Scan button): skipped, not failed — that
  // generator is writing the same rows (lib/server/notification-generation-lease.ts).
  let generationHeld = 0;
  const startedAt = Date.now();
  // Rotated, bounded and budgeted (lib/server/cron-family-sweep.ts), for the
  // same reason as the notifications cron: a serial `order('id')` loop with no
  // budget served the same prefix every tick and never reached push dispatch.
  // Named by its slot (lib/server/cron-slot.ts): the UTC day picks the start
  // and the two-hour slot moves it on by its share of the ring. Numbered by the
  // two-hour slot alone, the one run vercel.json sends (12:00, index 12d+6)
  // always started in the same quarter of the ring when only it fired.
  const run = lastDailySlot(startedAt, PUSH_SCAN_SLOTS);
  const swept = await sweepFamilies(families ?? [], {
    budgetMs: GENERATION_BUDGET_MS, itemTimeoutMs: FAMILY_TIMEOUT_MS, concurrency: FAMILY_CONCURRENCY, startedAt,
    runIndex: run.day, slot: { index: run.slot, of: PUSH_SCAN_SLOTS.length },
  }, async (f, counted) => {
    try {
      const lease = await claimGenerationLease(supabase, f.id);
      if (lease.state === 'held') { if (counted.current) generationHeld += 1; }
      else if (lease.state === 'error') { if (counted.current) generationFailures += 1; }
      else {
        const { release } = lease;
        try {
          // Failed source reads count as a failed family, not a quiet one.
          const report: NotificationGenerationReport = { failedSources: [] };
          const made = await generateFamilyNotifications(supabase, f.id, report);
          if (counted.current) {
            created += made;
            if (report.failedSources.length) {
              generationFailures += 1;
              console.error(`Notification generation incomplete for family ${f.id}:`, report.failedSources);
            }
          }
        } finally {
          await release();
        }
      }
    } catch (e) {
      if (counted.current) generationFailures += 1;
      console.error(`Notification generation failed for family ${f.id}:`, e);
    }
    try {
      const scope = await systemScopeForFamily(supabase, f.id);
      const sweptChores = scope ? await respawnMissingChoreAssignments(scope) : null;
      if (!counted.current) return;
      if (!sweptChores || !sweptChores.ok || sweptChores.data.failed > 0) respawnFailures += 1;
      if (sweptChores?.ok) respawned += sweptChores.data.respawned;
    } catch (e) {
      if (counted.current) respawnFailures += 1;
      console.error(`Chore respawn sweep failed for family ${f.id}:`, e);
    }
  });
  for (const f of swept.timedOut) {
    generationFailures += 1;
    console.error(`Push-scan gave up waiting for family ${f.id} after ${FAMILY_TIMEOUT_MS} ms`);
  }
  // Families this run never STARTED: the budget ran out first. A failed run,
  // decided below — an unserved tail must not look like a clean one.
  const unserved = swept.unreached.length;
  if (unserved > 0) console.error(`[push-scan] budget reached with ${unserved} families unserved`, swept.unreached.slice(0, 50).map((f) => f.id));

  let pushed = { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } };
  let pushDispatchFailures = 0;
  try {
    pushed = await dispatchPendingPushes(supabase);
  } catch (e) {
    pushDispatchFailures = 1;
    console.error('Push dispatch failed:', e);
  }

  const failed = generationFailures + respawnFailures + pushDispatchFailures + pushed.result.failed + pushed.result.skipped + unserved;
  const ok = failed === 0;
  return NextResponse.json(
    { ok, families: families?.length ?? 0, created, generationHeld, unserved, respawned, pushed, failed },
    { status: ok ? 200 : 502 },
  );
}
