// lib/ai/runs/evidence.ts — the persisted rows that say WHAT a run did and
// WHY, for the Handled ledger (M6) and the run history (M35).
//
// "Completed by Bubaly" used to show a title and a link; the tool that acted
// and the plan's reasoning were one click away on the run page. This reads
// them for a batch of runs in three statements — the plan's act/notify steps
// (`tool_name`), the succeeded `ai_tool_calls` rows (the per-write ledger 0250
// keeps, with the resource each touched) and the plan's user-facing
// `reasoning_summary` — so a ledger row can say "via Calendar · Tasks" and
// why, from state that was written when the work happened. Nothing here is
// inferred: a run these tables say nothing about gets an empty source and no
// reason, and the components render exactly that.
//
// Uses the CALLER's client on purpose, like `loadRunDetail`: 0250 gives
// members SELECT on all three tables, so a member sees what RLS lets them see
// and another family's rows are simply absent. Every statement still filters
// `family_id`, so the same function is right under the service client.
//
// Fails closed. A ledger that silently lost its sources after a failed read
// would still say "done" — plausibly, and wrongly — so a read error is
// returned as retryable and the caller shows it.
//
// TODO(M35 dead-letter): `ai_tool_calls` rows a dead worker left in
// 'reserved' are only reconciled at the run level by 0263; marking them
// 'unknown' with a timeline note needs a follow-up to `claim_ai_runs`, and
// until then such rows are simply not `succeeded` and so never count here.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult } from '@/lib/services/types';
import {
  EMPTY_EVIDENCE, type CompletedEvidence, type CompletedPlanRow, type CompletedStepRow, type CompletedToolCallRow,
} from '@/lib/home/today';

type DB = SupabaseClient<Database>;

export async function loadRunEvidence(
  db: DB,
  familyId: string,
  runs: readonly { id: string; plan_id?: string | null }[],
): Promise<ServiceResult<CompletedEvidence>> {
  const runIds = [...new Set(runs.map((r) => r.id))];
  const planIds = [...new Set(runs.map((r) => r.plan_id).filter((id): id is string => !!id))];
  if (!runIds.length) return ok(EMPTY_EVIDENCE);

  try {
    const [{ data: steps, error: stepsError }, { data: calls, error: callsError }, { data: plans, error: plansError }] = await Promise.all([
      planIds.length
        ? db.from('ai_plan_steps').select('id, plan_id, step_type, tool_name, status')
          .eq('family_id', familyId).in('plan_id', planIds).order('sequence', { ascending: true })
        : Promise.resolve({ data: [] as CompletedStepRow[], error: null }),
      db.from('ai_tool_calls').select('run_id, plan_step_id, tool_name, state, resource_table')
        .eq('family_id', familyId).in('run_id', runIds).eq('state', 'succeeded').order('created_at', { ascending: true }),
      planIds.length
        ? db.from('ai_plans').select('id, reasoning_summary').eq('family_id', familyId).in('id', planIds)
        : Promise.resolve({ data: [] as CompletedPlanRow[], error: null }),
    ]);
    const readError = stepsError ?? callsError ?? plansError;
    if (readError) {
      console.error('[ai/runs] run evidence read failed', readError);
      return fail(describeDbError(readError, 'Bubaly could not read what it did.'), { code: SERVICE_CODES.db, retryable: true });
    }
    return ok({
      steps: (steps ?? []) as CompletedStepRow[],
      toolCalls: (calls ?? []) as CompletedToolCallRow[],
      plans: (plans ?? []) as CompletedPlanRow[],
    });
  } catch (error) {
    console.error('[ai/runs] run evidence read failed', error);
    return fail(describeDbError(error, 'Bubaly could not read what it did.'), { code: SERVICE_CODES.db, retryable: true });
  }
}
