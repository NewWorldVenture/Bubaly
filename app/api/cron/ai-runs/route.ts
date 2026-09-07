import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { replanPortFor } from '@/lib/ai/planner/replan-port';
import { runGraph } from '@/lib/ai/runs/executor';
import { claimRuns, releaseRun } from '@/lib/ai/runs/store';
import { legacyStatusFor } from '@/lib/ai/runs/states';

export const runtime = 'nodejs';
export const maxDuration = 120;

// The continuation worker for AI runs (§9, §10, §39).
//
// An interactive request starts a run and returns immediately; `after()` gives
// the first slice whatever is left of that invocation. Everything else - runs
// parked on a time budget, runs resumed by an approval, scheduled follow-ups,
// and runs whose worker died - is carried forward here.
//
// WHY the tick is boxed at 85 s inside a 120 s function: the GitHub Actions
// dispatcher (scripts/cron-dispatch.mjs) aborts any route after 120 s and exits
// 1 on the first failure, and every 5-minute route shares one `cron-dispatch`
// concurrency group. A route that runs long would therefore mark the tick FAILED
// and delay every other route behind it. Runs are executed one at a time with a
// per-run slice, and anything claimed but not reached is handed straight back to
// the queue rather than held for the length of its lease.
const TICK_BUDGET_MS = 85_000;
const PER_RUN_BUDGET_MS = 25_000;
/** Below this there is not enough time to do useful work and still persist. */
const MIN_SLICE_MS = 12_000;
const WAVE_SIZE = 4;
/** Longer than a slice, so a run in flight never looks abandoned to the recovery pass. */
const LEASE_SECONDS = 180;

export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('aiRuns.unauthorized') }, { status: 401 });
  }

  const startedAt = Date.now();
  const deadline = startedAt + TICK_BUDGET_MS;
  const db = createServiceClient();
  const results: Array<{ runId: string; status: string; completed: number; failed: number }> = [];
  let claimedTotal = 0;
  let returned = 0;
  let claimFailures = 0;

  try {
    while (Date.now() + MIN_SLICE_MS < deadline) {
      const claim = await claimRuns(db, WAVE_SIZE, LEASE_SECONDS);
      if (!claim.ok) {
        claimFailures += 1;
        break;
      }
      if (!claim.data.length) break;
      claimedTotal += claim.data.length;

      for (const run of claim.data) {
        const remaining = deadline - Date.now();
        if (remaining < MIN_SLICE_MS) {
          // Out of tick. Put it back exactly as it was found so the next tick
          // (or an approval decision) picks it up without waiting out the lease.
          const { error } = await db
            .from('family_automation_runs')
            .update({
              state: 'ready',
              status: legacyStatusFor('ready'),
              lease_owner: null,
              lease_expires_at: null,
              run_after: new Date().toISOString(),
            })
            .eq('id', run.id)
            .eq('family_id', run.familyId)
            .eq('state', 'executing');
          if (error) console.error('[cron/ai-runs] failed to return a run to the queue', error);
          returned += 1;
          continue;
        }

        try {
          const result = await runGraph(run.id, { budgetMs: Math.min(PER_RUN_BUDGET_MS, remaining - 2_000), db, replan: replanPortFor(db) });
          results.push({ runId: run.id, status: result.status, completed: result.completed, failed: result.failed });
        } catch (error) {
          // One bad run must not take the tick down: the lease is released so
          // the recovery pass in `claim_ai_runs` can retry it, and the next run
          // in the wave still gets its slice.
          console.error('[cron/ai-runs] run threw', run.id, error);
          results.push({ runId: run.id, status: 'error', completed: 0, failed: 0 });
          if (run.leaseOwner) await releaseRun(db, run.id, run.leaseOwner);
        }
      }
    }

    return NextResponse.json({
      ok: claimFailures === 0,
      claimed: claimedTotal,
      executed: results.length,
      returnedToQueue: returned,
      elapsedMs: Date.now() - startedAt,
      results,
    }, { status: claimFailures === 0 ? 200 : 502 });
  } catch (error) {
    console.error('[cron/ai-runs] tick failed', error);
    return NextResponse.json({ error: t('aiRuns.aiRunContinuationFailed') }, { status: 500 });
  }
}
