// Whether a family may still have its agent runs executed.
//
// A run is Ask Bubaly's work ('ai-requests', a Family Basic feature): every
// run is filed through `submitRequest` behind `assertAIAccess`, and the run
// controls that restart one (answer, resume, re-run, edit) ask that gate
// again. Execution itself is reached from many more places than those — the
// ai-runs cron, the routine cron, an approval decision, the notifications
// cron's settled-run sweep — and only the ai-runs cron used to ask. A family
// whose trial ended unpaid, whose plan dropped below the tier, or whose admin
// switched Ask Bubaly Off kept having its runs executed through every other
// door. So the question lives here, once, and `continueRun` (the one place
// every kick goes through) and the crons answer it the same way.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { familyHasFeature, getFeatureTiersByHref } from '@/lib/server/feature-entitlement';
import type { FeatureTier } from '@/lib/constants/feature-catalog';

type DB = SupabaseClient<Database>;

/** The feature a run is the work of: Ask Bubaly ('ai-requests'). */
export const AI_RUNS_FEATURE_HREF = '/dashboard/concierge/runs';

/**
 * How far out a run of a family without Ask Bubaly is put back: looked at
 * again daily, not every wave, so it cannot head every tick's queue — and not
 * cancelled, so a family that subscribes again picks up where it left off.
 */
export const UNENTITLED_RUN_DEFER_MS = 24 * 60 * 60_000;

/**
 * `entitled`, `unentitled`, or `unknown` when the plan or the admin's tiers
 * could not be read. Unknown is never an answer either way: a caller holds the
 * work for now and says so, rather than running it or deferring it a day.
 */
export type AgentRunEntitlement = 'entitled' | 'unentitled' | 'unknown';

/**
 * A checker for one pass: the tier map is read once and each family is asked
 * once, however many runs or routines it has in the pass.
 */
export function agentRunEntitlementChecker(db: DB): (familyId: string) => Promise<AgentRunEntitlement> {
  let tiers: Promise<Record<string, FeatureTier>> | null = null;
  const answers = new Map<string, Promise<AgentRunEntitlement>>();
  return (familyId: string) => {
    let answer = answers.get(familyId);
    if (!answer) {
      answer = (async (): Promise<AgentRunEntitlement> => {
        try {
          tiers ??= getFeatureTiersByHref(db, { onUnavailable: 'throw' });
          return (await familyHasFeature(db, familyId, AI_RUNS_FEATURE_HREF, await tiers)) ? 'entitled' : 'unentitled';
        } catch (error) {
          console.error('[ai/runs] could not read whether the family has Ask Bubaly', { familyId, error });
          // A failed tier read is not cached: the next family asks again.
          tiers = null;
          return 'unknown';
        }
      })();
      answers.set(familyId, answer);
    }
    return answer;
  };
}
