import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readAll } from '@/lib/supabase/read-all';
import { generateFamilyNotifications, type NotificationGenerationReport } from '@/lib/server/notifications';
import { dispatchPendingPushes } from '@/lib/server/push';
import { deliverNotificationEmails } from '@/lib/server/notification-emails';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { deliverMorningBriefs } from '@/lib/briefing/deliver';
import { expireStale, remindPendingApprovals, resumeSettledRuns } from '@/lib/services/approvals';
import { sweepFamilies } from '@/lib/server/cron-family-sweep';
import { claimGenerationLease } from '@/lib/server/notification-generation-lease';

export const runtime = 'nodejs';
// Chosen rather than inherited from the platform default. The generation loop
// below is where the time goes — a dozen round trips per family — and push and
// email dispatch run only after it, so a run killed at the platform's limit
// delivered nothing that day and answered with nothing to count.
export const maxDuration = 300;
// Generation stops STARTING families once this much is spent, leaving the rest
// of maxDuration for the approval sweeps, the morning briefs, push dispatch
// (its own PUSH_DISPATCH_BUDGET_MS) and the email digests — so the rows already
// queued are always delivered, whatever generation managed.
const GENERATION_BUDGET_MS = 150_000;
// One family's reads outliving this are that family's failure, not the run's.
const FAMILY_TIMEOUT_MS = 20_000;
const FAMILY_CONCURRENCY = 4;
const DAY_MS = 86_400_000;

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
  // Every household — see lib/supabase/read-all.ts for why an unbounded select
  // silently stops at PostgREST's row ceiling. Every OPEN household: a family
  // that closed its account (families.closed_at) is not notified. The delivery
  // steps below skip closed families' queued rows the same way.
  const { rows: families, error } = await readAll<{ id: string }>(
    (from, to) => supabase.from('families').select('id').is('closed_at', null).order('id').range(from, to),
  );
  if (error) {
    console.error('Notification cron read failed:', error);
    return NextResponse.json({ error: t('notifications.notificationProcessingFailed') }, { status: 500 });
  }

  let total = 0;
  let generationFailures = 0;
  // Families another generator holds right now (the push scan on its mirrored
  // minute, a member's Scan button): skipped, not failed — that generator is
  // writing the same rows (lib/server/notification-generation-lease.ts).
  let generationHeld = 0;
  const startedAt = Date.now();
  // Rotated, bounded and budgeted (lib/server/cron-family-sweep.ts): the loop
  // used to await every family in `order('id')` with no budget and no timeout,
  // so a run killed at the platform's limit served the same prefix every day
  // and never reached the delivery steps below. `counted.current` is false once
  // the pass stopped waiting for this family: a result that arrives after its
  // timeout was already counted as one.
  const swept = await sweepFamilies(families ?? [], {
    // Daily: the day is the run's index, so consecutive runs start apart.
    budgetMs: GENERATION_BUDGET_MS, itemTimeoutMs: FAMILY_TIMEOUT_MS, concurrency: FAMILY_CONCURRENCY, startedAt, runIndex: Math.floor(startedAt / DAY_MS),
  }, async (f, counted) => {
    try {
      const lease = await claimGenerationLease(supabase, f.id);
      if (lease.state === 'held') { if (counted.current) generationHeld += 1; return; }
      if (lease.state === 'error') { if (counted.current) generationFailures += 1; return; }
      const { release } = lease;
      try {
        // A family whose source reads did not all answer is a failure of this
        // tick, not a quiet family: it used to answer 200 ok however many reads
        // had failed, because only a throw was counted.
        const report: NotificationGenerationReport = { failedSources: [] };
        const created = await generateFamilyNotifications(supabase, f.id, report);
        if (!counted.current) return;
        total += created;
        if (report.failedSources.length) {
          generationFailures += 1;
          console.error(`Notification generation incomplete for family ${f.id}:`, report.failedSources);
        }
      } finally {
        await release();
      }
    } catch (e) {
      if (counted.current) generationFailures += 1;
      console.error(`Notification generation failed for family ${f.id}:`, e);
    }
  });
  for (const f of swept.timedOut) {
    generationFailures += 1;
    console.error(`Notification generation gave up waiting for family ${f.id} after ${FAMILY_TIMEOUT_MS} ms`);
  }
  // Families this run never STARTED: the budget ran out first. A failed run,
  // decided below — an unserved tail must not look like a clean one.
  const unserved = swept.unreached.length;
  if (unserved > 0) console.error(`[notifications] budget reached with ${unserved} families unserved`, swept.unreached.slice(0, 50).map((f) => f.id));

  // AI approvals (0251): expire the ones nobody answered so their runs stop
  // honestly, then remind each manager once about the ones still open. Both
  // run before push dispatch so the reminders ride the same tick's pushes.
  // A sweep failure counts as a generation failure: the reminders it would
  // have produced are notifications this tick did not generate.
  // The sweeps RETURN their failures (a refused read or write) rather than
  // throw, so those are counted here too: a tick whose approvals stopped
  // expiring or reminding must answer 502, not 200.
  //
  // `resumeSettledRuns` runs after the expiry: a run still parked on an
  // approval that was decided (or expired) while its fold failed is returned
  // to the queue, since no claim path ever leases `awaiting_approval`.
  let approvals = { expired: 0, blockedRuns: 0, reminded: 0, remindedFamilies: 0, resumedRuns: 0, failures: 0 };
  try {
    const swept = await expireStale(supabase);
    const resumed = await resumeSettledRuns(supabase);
    const reminded = await remindPendingApprovals(supabase);
    const failures = swept.failures + resumed.failures + reminded.failures;
    generationFailures += failures;
    approvals = {
      expired: swept.expired, blockedRuns: swept.blockedRuns, reminded: reminded.reminded, remindedFamilies: reminded.families,
      resumedRuns: resumed.resumed, failures,
    };
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
  let pushed = { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } };
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

  const failed = generationFailures + pushDispatchFailures + pushed.result.failed + pushed.result.skipped + emailDeliveryFailures + emailed.failed + unserved;
  const ok = failed === 0;
  return NextResponse.json(
    { ok, families: families?.length ?? 0, created: total, generationHeld, unserved, approvals, briefs, pushed, emailed: emailed.sent, emailFailures: emailed.failed, emailSkipped: emailed.skipped, failed },
    { status: ok ? 200 : 502 },
  );
}
