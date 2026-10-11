import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { replanPortFor } from '@/lib/ai/planner/replan-port';
import { runGraph } from '@/lib/ai/runs/executor';
import { claimRuns, releaseRun } from '@/lib/ai/runs/store';
import { legacyStatusFor } from '@/lib/ai/runs/states';
import { wroteNoRows } from '@/lib/supabase/errors';

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
/** How far out a closed family's claimed run is put back: it is looked at again daily, not every wave. */
const CLOSED_FAMILY_DEFER_MS = 24 * 60 * 60_000;

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
  let deferredClosed = 0;

  // Return a claimed run to the queue, due at `runAfter`. `returned` counted a
  // run whether or not the write failed — and the `state = 'executing'` guard
  // exists precisely because the run may have moved on (an approval, a
  // cancel), so zero rows is ordinary. A run counts as returned only when it
  // actually was. Audit C1-S9-63.
  const requeue = async (run: { id: string; familyId: string }, runAfter: Date): Promise<boolean> => {
    const { data: requeued, error } = await db
      .from('family_automation_runs')
      .update({
        state: 'ready',
        status: legacyStatusFor('ready'),
        lease_owner: null,
        lease_expires_at: null,
        run_after: runAfter.toISOString(),
      })
      .eq('id', run.id)
      .eq('family_id', run.familyId)
      .eq('state', 'executing')
      .select('id');
    if (error) console.error('[cron/ai-runs] failed to return a run to the queue', error);
    return !error && !wroteNoRows(requeued);
  };

  try {
    while (Date.now() + MIN_SLICE_MS < deadline) {
      const claim = await claimRuns(db, WAVE_SIZE, LEASE_SECONDS);
      if (!claim.ok) {
        claimFailures += 1;
        break;
      }
      if (!claim.data.length) break;
      claimedTotal += claim.data.length;

      // Runs of a family that closed its account (families.closed_at) are not
      // executed. `claim_ai_runs` is SQL and picks by due-ness alone, so a
      // closed family's run is set aside here: back to the queue a day out —
      // not cancelled, so reopening resumes it, and not straight back, so it
      // cannot head every wave of every tick ahead of the open families' runs.
      const claimedFamilies = [...new Set(claim.data.map((r) => r.familyId))];
      const { data: closedRows, error: closedError } = await db
        .from('families').select('id').in('id', claimedFamilies).not('closed_at', 'is', null);
      if (closedError) {
        // Which families are closed is unknown, so nothing in this wave runs.
        console.error('[cron/ai-runs] could not read whether the claimed runs\' families are closed', closedError);
        for (const run of claim.data) if (await requeue(run, new Date())) returned += 1;
        claimFailures += 1;
        break;
      }
      const closedFamilies = new Set((closedRows ?? []).map((f) => f.id));

      for (const run of claim.data) {
        if (closedFamilies.has(run.familyId)) {
          if (await requeue(run, new Date(Date.now() + CLOSED_FAMILY_DEFER_MS))) deferredClosed += 1;
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining < MIN_SLICE_MS) {
          // Out of tick. Put it back exactly as it was found so the next tick
          // (or an approval decision) picks it up without waiting out the lease.
          if (await requeue(run, new Date())) returned += 1;
          continue;
        }

        try {
          const result = await runGraph(run.id, { budgetMs: Math.min(PER_RUN_BUDGET_MS, remaining - 2_000), db, replan: replanPortFor(db) });
          results.push({ runId: run.id, status: result.status, completed: result.completed, failed: result.failed });
        } catch (error) {
          // One bad run must not take the tick down: the lease is shortened so
          // the recovery pass in `claim_ai_runs` retries it on the NEXT tick (or
          // dead-letters it once its attempts are spent), and the next run in
          // the wave still gets its slice. Shortened, not cleared — a lease-less
          // `executing` run is one that pass never looks at — and not expired
          // outright, or this tick's next wave would claim it straight back and
          // a repeatable throw would burn every attempt in seconds (releaseRun).
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
      deferredClosed,
      elapsedMs: Date.now() - startedAt,
      results,
    }, { status: claimFailures === 0 ? 200 : 502 });
  } catch (error) {
    console.error('[cron/ai-runs] tick failed', error);
    return NextResponse.json({ error: t('aiRuns.aiRunContinuationFailed') }, { status: 500 });
  }
}
