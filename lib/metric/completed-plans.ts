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
 * records count only when a durable completion timestamp exists. */
function completedRunQuery(db: DB, familyId: string) {
  return db.from('family_automation_runs').select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .or('state.eq.completed,status.eq.executed')
    .or('state.eq.completed,state.in.(queued,awaiting_approval),state.is.null');
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
