import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { countOrNull } from './count';

type DB = SupabaseClient<Database>;
const WEEK_MS = 7 * 86_400_000;

export type CompletedPlansResult =
  | { available: true; completedRuns: number; undatedCompletedRuns: number; sinceIso: string; untilIso: string }
  | { available: false };

/** Completed runs only: partial runs also have legacy status=executed, so that
 * status cannot override an explicit partial, failed or cancelled state.
 * The queued/null states predate the lifecycle column. The concierge approval
 * writer also leaves awaiting_approval beside executed (actions.ts); those
 * records count only when a durable completion timestamp exists.
 *
 * A typed concierge request's run is a plan only once a plan is attached to
 * it. Two writers close one that never got a plan as `completed`: an answer or
 * recommendation given after a clarifying question (answerClarification), and
 * the placeholder retired when the cron had already claimed the planner's own
 * run (adoptPlannedRun) — which also counted that one request twice. The same
 * answer on the first turn files no run at all. So a `concierge` run without a
 * `plan_id` is not a plan Bubaly ran; every other run type counts as before
 * (`run_type` is NOT NULL, default 'concierge_plan', 0250). */
function completedRunQuery(db: DB, familyId: string) {
  return db.from('family_automation_runs').select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .or('state.eq.completed,status.eq.executed')
    .or('state.eq.completed,state.in.(queued,awaiting_approval),state.is.null')
    .or('not.and(run_type.eq.concierge,plan_id.is.null)');
}

/** Recorded completion counts for the shared planning-time model.
 * One primary-key row counts once, regardless of its steps/activity.
 * created_at and approved_at never stand in for completion. Undated completed
 * records are reported across all history because their week is unknowable. */
export async function loadCompletedPlans(db: DB, familyId: string, now = new Date()): Promise<CompletedPlansResult> {
  try {
    if (!familyId.trim() || !Number.isFinite(now.getTime())) throw new Error('Run value scope or window unavailable');
    const untilIso = now.toISOString();
    const sinceIso = new Date(now.getTime() - WEEK_MS).toISOString();
    const [completedRuns, undatedCompletedRuns] = await Promise.all([
      countOrNull(Promise.resolve().then(() => completedRunQuery(db, familyId)
        .gte('completed_at', sinceIso).lte('completed_at', untilIso)), 'recorded completed plans'),
      countOrNull(Promise.resolve().then(() => completedRunQuery(db, familyId)
        .is('completed_at', null).lte('created_at', untilIso)), 'undated completed plans'),
    ]);
    if (completedRuns === null || undatedCompletedRuns === null) return { available: false };
    return { available: true, completedRuns, undatedCompletedRuns, sinceIso, untilIso };
  } catch (error) {
    console.error('[metric] recorded completed plans unavailable', error);
    return { available: false };
  }
}
