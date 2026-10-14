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
import { replanPortFor } from '@/lib/ai/planner/replan-port';
import { createServiceClient } from '@/lib/supabase/server';
import { runGraph, type RunGraphResult } from './executor';
import { claimRun, releaseRun, type RunRow } from './store';
import { legacyStatusFor } from './states';
import { agentRunEntitlementChecker, UNENTITLED_RUN_DEFER_MS } from './entitlement';

export type ContinueResult = RunGraphResult & { claimed: boolean };

/** Lease length: the slice plus enough slack that a slow finish never looks abandoned. Clamped to what `claim_ai_runs` accepts. */
function leaseSecondsFor(budgetMs: number): number {
  return Math.max(30, Math.min(900, Math.ceil(budgetMs / 1000) + 60));
}

/**
 * Hand a claimed run back to the queue without running it, due at `runAfter`.
 *
 * The same return the ai-runs cron makes for a family that lost Ask Bubaly —
 * `ready`, lease cleared — fenced on this worker's own lease, so a run another
 * worker or a control moved in the meantime is left as it is. The claim
 * counted an attempt; a slice that never ran is not one, so the counter goes
 * back, or a family that lapsed for a week would find its run dead-lettered
 * (or unclaimable here) the day it subscribed again.
 */
async function handBack(db: SupabaseClient<Database>, run: RunRow, leaseOwner: string, runAfter: Date): Promise<void> {
  const { data, error } = await db
    .from('family_automation_runs')
    .update({
      state: 'ready',
      status: legacyStatusFor('ready'),
      lease_owner: null,
      lease_expires_at: null,
      run_after: runAfter.toISOString(),
      attempt: Math.max(0, run.attempt - 1),
    })
    .eq('id', run.id)
    .eq('family_id', run.family_id)
    .eq('lease_owner', leaseOwner)
    .eq('state', 'executing')
    .select('id');
  if (error) console.error('[ai/runs] could not hand an unexecuted run back to the queue; its lease will run out', error);
  else if (!data?.length) console.warn('[ai/runs] the run moved on before it could be handed back', { runId: run.id });
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
  const claimed = claim.data.run;
  try {
    // Every kick comes through here — the request route, the run controls, an
    // approval decision, the settled-run sweep, the routine cron — and only
    // the ai-runs cron used to ask whether the family still has Ask Bubaly. A
    // lapsed or Free family's run kept writing to its household and calling
    // the planner through every other door. Not entitled: back to the queue a
    // day out, as the cron does. Unknown (an unreadable plan or tier map):
    // back now, unexecuted, for the next look to decide.
    const entitlement = claimed ? await agentRunEntitlementChecker(db)(claimed.family_id) : 'unknown';
    if (entitlement !== 'entitled') {
      const runAfter = entitlement === 'unentitled' ? new Date(Date.now() + UNENTITLED_RUN_DEFER_MS) : new Date();
      if (claimed && leaseOwner) await handBack(db, claimed, leaseOwner, runAfter);
      return {
        status: entitlement === 'unentitled' ? 'deferred_unentitled' : 'entitlement_unavailable',
        completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false,
      };
    }
    // The planner's re-planning port rides along so a `replan` step plans the
    // rest of the run (as a new plan version) instead of blocking.
    const result = await runGraph(runId, { budgetMs, db, replan: replanPortFor(db) });
    return { ...result, claimed: true };
  } finally {
    // The executor clears the lease itself when it parks or finishes; this is
    // the path for a throw, so a crashed slice does not hold the run hostage
    // for the whole lease window — the lease is shortened to a couple of
    // minutes, and the next cron tick's `claim_ai_runs` recovers the run.
    // (Clearing it instead would strand the run in `executing` with no lease,
    // which that pass never looks at.)
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
