// Continuation: how a run gets picked up again after the invocation that
// started it went away.
//
// Two callers, one guarantee. The cron leases a BATCH through the
// `claim_ai_runs` RPC and executes each id; an interactive request leases ONE
// run with `claimRun` and executes it in the background. Both go through a
// lease, because Vercel and the GitHub Actions dispatcher can call the same
// route at overlapping times and a run executed twice is duplicate calendar
// events and duplicate messages - exactly what §30 exists to prevent.
//
// WHY `continueRun` does not use the `claim_ai_runs` RPC: that function selects
// by due-ness, not by id. Asking it for a specific run would lease whichever
// runs happen to be oldest - possibly another household's - and then drop them
// unexecuted with their `attempt` counter already spent. `store.claimRun`
// applies the same lease and the same recovery predicate to one row, guarded on
// `attempt` so two concurrent claims of that row cannot both win.
import 'server-only';
import { after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { runGraph, type RunGraphResult } from './executor';
import { claimRun, releaseRun } from './store';

export type ContinueResult = RunGraphResult & { claimed: boolean };

/** Lease length: the slice plus enough slack that a slow finish never looks abandoned. Clamped to what `claim_ai_runs` accepts. */
function leaseSecondsFor(budgetMs: number): number {
  return Math.max(30, Math.min(900, Math.ceil(budgetMs / 1000) + 60));
}

/**
 * Claim one run, execute a slice of it, release the lease.
 *
 * A run that is not claimable - already leased by another worker, paused,
 * cancelled, waiting on an approval, or out of attempts - is reported as
 * `claimed: false` rather than as an error. That is the normal outcome when two
 * things try to move the same run forward at once, and the loser must not
 * rewrite the winner's state.
 */
export async function continueRun(
  runId: string,
  opts?: { budgetMs?: number; db?: SupabaseClient<Database> },
): Promise<ContinueResult> {
  const db = opts?.db ?? createServiceClient();
  const budgetMs = Math.max(1_000, opts?.budgetMs ?? 45_000);

  const claim = await claimRun(db, runId, leaseSecondsFor(budgetMs));
  if (!claim.ok) {
    console.error('[ai/runs] could not claim the run for continuation', claim.error);
    return { status: 'error', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false };
  }
  if (!claim.data.claimed) {
    return {
      status: claim.data.run?.state ?? 'unavailable',
      completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false,
    };
  }

  const leaseOwner = claim.data.leaseOwner;
  try {
    const result = await runGraph(runId, { budgetMs, db });
    return { ...result, claimed: true };
  } finally {
    // The executor clears the lease itself when it parks or finishes; this is
    // the path for a throw, so a crashed slice does not hold the run hostage
    // for the whole lease window.
    if (leaseOwner) await releaseRun(db, runId, leaseOwner);
  }
}

/**
 * Execute a slice AFTER the response has been sent.
 *
 * An interactive request must return as soon as the plan is persisted (§4.3):
 * the UI subscribes to `ai_plan_steps` and `family_automation_runs` for
 * progress, so making the caller wait on execution buys nothing and risks the
 * request timing out mid-workflow. `after()` shares the invocation's
 * `maxDuration`, which is why the budget is explicit here rather than defaulted
 * - the caller knows how much of its own function it has already spent. The
 * precedent for `after()` in this repo is `lib/reasoning/auto-refresh.ts`.
 *
 * Never throws: a failed kick leaves the run `ready` with `run_after` already
 * in the past, and `/api/cron/ai-runs` picks it up on the next tick.
 */
export function kickRun(runId: string, opts?: { budgetMs?: number }): void {
  try {
    after(async () => {
      try {
        await continueRun(runId, { budgetMs: opts?.budgetMs });
      } catch (error) {
        console.error('[ai/runs] background continuation failed', error);
      }
    });
  } catch (error) {
    // `after()` throws when called outside a request scope. The cron is the
    // backstop, so this is logged rather than surfaced to the caller.
    console.error('[ai/runs] could not schedule the background continuation', error);
  }
}
