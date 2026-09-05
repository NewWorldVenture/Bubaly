// Run controls - the human levers over an autonomous run (§9, §17, §45).
//
// The rule that shapes this file: a control must take effect on work that is
// ALREADY IN FLIGHT, not merely on work that has not started. The executor
// re-reads the run row on every pass precisely so `cancel_requested_at` and
// `paused_at` reach a slice that is halfway through a graph. Cancelling
// therefore does three things in one call - stops the run, cancels the
// approvals it opened, and cancels the steps that had not run - because a
// half-cancelled run leaves a pending approval that would later resume work the
// family already stopped.
//
// Authority: pause, resume and cancel are available to a family manager OR to
// the member who asked for the run - stopping your own work is never an
// escalation. `rerunStep` and `editStepInput` cause new writes with the run's
// authority, so those are managers only. Every control writes an `audit_logs`
// row, the same way `lib/family/actions.ts` audits its generic writes.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { canTransitionRun, isTerminalRunState, legacyStatusFor, type RunState, type StepState } from './states';
import {
  appendEvent, ledgerClient, loadPlanSteps, loadRun, savePlan, updateRequest, updateRun, updateStep,
  type PlanStepInput, type RunRow, type StepRow, type StoreOpts,
} from './store';

export type ControlOpts = StoreOpts;

/** Step states that have not produced a result yet, so cancelling or re-planning them loses nothing. */
const UNSTARTED_STEP_STATES: readonly StepState[] = ['queued', 'ready', 'awaiting_approval', 'executing', 'planning', 'awaiting_context'];

type Access = { run: RunRow; db: SupabaseClient<Database> };

async function openRun(
  scope: ServiceScope,
  runId: string,
  opts: ControlOpts | undefined,
  requireManager: boolean,
): Promise<ServiceResult<Access>> {
  const db = ledgerClient(scope, opts);
  const loaded = await loadRun(scope, runId, { db });
  if (!loaded.ok) return loaded;
  const run = loaded.data;
  if (!run) return fail('That run could not be found.', { code: SERVICE_CODES.notFound });

  const manager = isManager(scope.role);
  const requester = !!scope.memberId && run.requested_by_member_id === scope.memberId;
  if (requireManager ? !manager : !manager && !requester) {
    return fail('Only a parent or adult in the family can do that.', { code: SERVICE_CODES.denied });
  }
  return ok({ run, db });
}

async function audit(
  scope: ServiceScope,
  db: SupabaseClient<Database>,
  action: string,
  runId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from('audit_logs').insert({
    family_id: scope.familyId,
    actor_id: scope.userId,
    action,
    resource: 'family_automation_runs',
    resource_id: runId,
    metadata: metadata as Json,
  });
  // The control itself already succeeded; losing the audit row must not undo it,
  // but it must be visible in the logs.
  if (error) console.error('[ai/runs] failed to write the control audit row', error);
}

/**
 * Stop taking new steps, keep everything already done.
 *
 * A paused run keeps its state so `claim_ai_runs` will not recover it: pausing
 * is a person's decision, not a stalled worker, and the recovery pass in 0250
 * deliberately leaves `paused` alone.
 */
export async function pauseRun(scope: ServiceScope, runId: string, opts?: ControlOpts): Promise<ServiceResult<{ state: RunState }>> {
  const access = await openRun(scope, runId, opts, false);
  if (!access.ok) return access;
  const { run, db } = access.data;

  if (isTerminalRunState(run.state as RunState)) {
    return fail('That run has already finished.', { code: SERVICE_CODES.invalidInput });
  }
  if (!canTransitionRun(run.state as RunState, 'paused')) {
    return fail('That run cannot be paused right now.', { code: SERVICE_CODES.invalidInput });
  }

  const now = new Date().toISOString();
  const updated = await updateRun(scope, runId, {
    state: 'paused',
    status: legacyStatusFor('paused'),
    paused_at: now,
    lease_owner: null,
    lease_expires_at: null,
  }, { db });
  if (!updated.ok) return updated;

  await appendEvent(scope, runId, { eventType: 'paused', message: 'Paused by a member of the family.' }, { db });
  if (run.request_id) await updateRequest(scope, run.request_id, { status: 'blocked' }, { db });
  await audit(scope, db, 'ai_run.pause', runId, { previous_state: run.state });
  return ok({ state: 'paused' });
}

/** Put a paused run back in the queue. `run_after = now` makes the next cron tick pick it up. */
export async function resumeRun(scope: ServiceScope, runId: string, opts?: ControlOpts): Promise<ServiceResult<{ state: RunState }>> {
  const access = await openRun(scope, runId, opts, false);
  if (!access.ok) return access;
  const { run, db } = access.data;

  if (run.state !== 'paused') return fail('That run is not paused.', { code: SERVICE_CODES.invalidInput });

  const updated = await updateRun(scope, runId, {
    state: 'ready',
    status: legacyStatusFor('ready'),
    paused_at: null,
    run_after: new Date().toISOString(),
    error: null,
  }, { db });
  if (!updated.ok) return updated;

  await appendEvent(scope, runId, { eventType: 'resumed', message: 'Resumed - Bubaly will pick this up again shortly.' }, { db });
  if (run.request_id) await updateRequest(scope, run.request_id, { status: 'ready', error: null }, { db });
  await audit(scope, db, 'ai_run.resume', runId, {});
  return ok({ state: 'ready' });
}

export type CancelResult = { state: RunState; cancelledSteps: number; cancelledApprovals: number };

/**
 * Stop the run for good.
 *
 * `cancel_requested_at` is what an in-flight slice sees on its next pass, and
 * the state is set to `cancelled` in the same statement so a run whose worker
 * has died does not sit in `executing` waiting for a lease to expire (the
 * recovery pass in `claim_ai_runs` would return it to `ready`, and its claim
 * predicate skips cancelled runs, leaving it stuck forever).
 *
 * Pending approvals are cancelled too: an approval left open would let someone
 * approve, hours later, work that the family has already called off.
 */
export async function cancelRun(scope: ServiceScope, runId: string, opts?: ControlOpts): Promise<ServiceResult<CancelResult>> {
  const access = await openRun(scope, runId, opts, false);
  if (!access.ok) return access;
  const { run, db } = access.data;

  if (isTerminalRunState(run.state as RunState)) {
    return ok({ state: run.state as RunState, cancelledSteps: 0, cancelledApprovals: 0 });
  }

  const now = new Date().toISOString();
  const updated = await updateRun(scope, runId, {
    state: 'cancelled',
    status: legacyStatusFor('cancelled'),
    cancel_requested_at: now,
    completed_at: now,
    lease_owner: null,
    lease_expires_at: null,
  }, { db });
  if (!updated.ok) return updated;

  let cancelledApprovals = 0;
  const { data: approvals, error: approvalError } = await db
    .from('approval_requests')
    .update({ status: 'cancelled', decided_at: now, decided_by: scope.userId })
    .eq('family_id', scope.familyId)
    .eq('run_id', runId)
    .eq('status', 'pending')
    .select('id');
  if (approvalError) {
    console.error('[ai/runs] failed to cancel the run approvals', approvalError);
    return fail(describeDbError(approvalError, 'Bubaly stopped the run but could not close its approval requests.'), {
      code: SERVICE_CODES.db, retryable: true,
    });
  }
  cancelledApprovals = (approvals ?? []).length;

  let cancelledSteps = 0;
  if (run.plan_id) {
    const { data: steps, error: stepError } = await db
      .from('ai_plan_steps')
      .update({ status: 'cancelled', error: 'Cancelled before this step ran.' })
      .eq('family_id', scope.familyId)
      .eq('plan_id', run.plan_id)
      .in('status', [...UNSTARTED_STEP_STATES])
      .select('id');
    if (stepError) {
      console.error('[ai/runs] failed to cancel the queued steps', stepError);
      return fail(describeDbError(stepError, 'Bubaly stopped the run but could not stop every queued step.'), {
        code: SERVICE_CODES.db, retryable: true,
      });
    }
    cancelledSteps = (steps ?? []).length;
  }

  await appendEvent(scope, runId, {
    eventType: 'cancelled',
    message: `Cancelled by a member of the family. ${cancelledSteps} step${cancelledSteps === 1 ? '' : 's'} did not run.`,
    payload: { cancelled_steps: cancelledSteps, cancelled_approvals: cancelledApprovals },
  }, { db });
  if (run.request_id) await updateRequest(scope, run.request_id, { status: 'cancelled', completed_at: now }, { db });
  await audit(scope, db, 'ai_run.cancel', runId, { cancelled_steps: cancelledSteps, cancelled_approvals: cancelledApprovals });

  return ok({ state: 'cancelled', cancelledSteps, cancelledApprovals });
}

export type RerunResult = { rerun: boolean; state: StepState; detail: string };

/**
 * Try one step again - the "allow safe retry" half of §29.
 *
 * The `ai_tool_calls` ledger is consulted first, and that check is the reason
 * this is not simply "set the status back to queued": if the step's tool call
 * actually SUCCEEDED (the write landed and the response was lost), re-running
 * it would create a second calendar event. In that case the step is reconciled
 * to `completed` against the row that already exists and nothing is executed.
 * A `failed` ledger row has its attempt bumped so the executor's idempotency
 * ledger takes it over and the retry really re-executes.
 */
export async function rerunStep(
  scope: ServiceScope,
  runId: string,
  stepId: string,
  opts?: ControlOpts,
): Promise<ServiceResult<RerunResult>> {
  const access = await openRun(scope, runId, opts, true);
  if (!access.ok) return access;
  const { run, db } = access.data;

  if (run.state === 'cancelled') return fail('That run was cancelled.', { code: SERVICE_CODES.invalidInput });
  if (!run.plan_id) return fail('That run has no plan.', { code: SERVICE_CODES.invalidInput });

  const steps = await loadPlanSteps(scope, run.plan_id, { db });
  if (!steps.ok) return steps;
  const step = steps.data.find((s) => s.id === stepId);
  if (!step) return fail('That step is not part of this run.', { code: SERVICE_CODES.notFound });

  const { data: calls, error: callError } = await db
    .from('ai_tool_calls')
    .select('id, state, attempt, resource_id, resource_table')
    .eq('family_id', scope.familyId)
    .eq('plan_step_id', stepId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (callError) {
    console.error('[ai/runs] failed to read the tool-call ledger for a rerun', callError);
    return fail(describeDbError(callError, 'Bubaly could not check what that step already did.'), {
      code: SERVICE_CODES.db, retryable: true,
    });
  }

  const succeeded = (calls ?? []).find((c) => c.state === 'succeeded');
  if (succeeded) {
    const detail = 'That step already succeeded, so Bubaly left the record it created alone instead of making a second one.';
    if (step.status !== 'completed') {
      await updateStep(scope, stepId, {
        status: 'completed',
        error: null,
        completed_at: new Date().toISOString(),
        result_json: { summary: detail, id: succeeded.resource_id, resource_table: succeeded.resource_table } as Json,
      }, { db });
      await appendEvent(scope, runId, { eventType: 'step_completed', stepId, message: detail }, { db });
    }
    await audit(scope, db, 'ai_run.rerun_step', runId, { step_id: stepId, executed: false });
    return ok({ rerun: false, state: 'completed', detail });
  }

  const failedCall = (calls ?? []).find((c) => c.state === 'failed');
  if (failedCall) {
    const { error: bumpError } = await db
      .from('ai_tool_calls')
      .update({ attempt: failedCall.attempt + 1 })
      .eq('id', failedCall.id)
      .eq('family_id', scope.familyId);
    if (bumpError) console.error('[ai/runs] failed to bump the tool-call attempt for a rerun', bumpError);
  }

  // The approval is cleared with the status: a step that was cancelled because
  // its approval was rejected must ask again rather than inherit that decision.
  const reset = await updateStep(scope, stepId, {
    status: 'queued',
    retry_count: 0,
    error: null,
    result_json: null,
    started_at: null,
    completed_at: null,
    approval_id: null,
  }, { db });
  if (!reset.ok) return reset;

  // Anything blocked behind this step becomes runnable again.
  const dependents = collectDependents(steps.data, stepId);
  for (const dependent of dependents) {
    if (dependent.status === 'blocked') {
      await updateStep(scope, dependent.id, { status: 'queued', error: null }, { db });
    }
  }

  const resumed = await updateRun(scope, runId, {
    state: 'ready',
    status: legacyStatusFor('ready'),
    run_after: new Date().toISOString(),
    completed_at: null,
    error: null,
  }, { db });
  if (!resumed.ok) return resumed;

  await appendEvent(scope, runId, {
    eventType: 'step_retried',
    stepId,
    message: `A member of the family asked Bubaly to try "${step.description || step.tool_name || step.step_type}" again.`,
    payload: { dependents_requeued: dependents.length },
  }, { db });
  if (run.request_id) await updateRequest(scope, run.request_id, { status: 'ready', error: null, completed_at: null }, { db });
  await audit(scope, db, 'ai_run.rerun_step', runId, { step_id: stepId, executed: true });

  return ok({ rerun: true, state: 'queued', detail: 'Bubaly will try that step again on the next pass.' });
}

/** Every step downstream of `stepId`, transitively. */
function collectDependents(steps: readonly StepRow[], stepId: string): StepRow[] {
  const doomed = new Set([stepId]);
  const found = new Map<string, StepRow>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (found.has(step.id) || step.id === stepId) continue;
      if (step.dependency_ids.some((id) => doomed.has(id))) {
        found.set(step.id, step);
        doomed.add(step.id);
        changed = true;
      }
    }
  }
  return [...found.values()];
}

export type EditStepResult = { planId: string; version: number; requeuedSteps: number };

/**
 * Change what a step will do, as a new plan version.
 *
 * Plans are versioned rather than edited in place (§13's Edit flow): the family
 * approved version N, so version N must remain readable exactly as it was. Work
 * that already finished is carried into the new version with its status and
 * result intact - except the edited step and everything downstream of it, which
 * are queued again, because their inputs have changed.
 */
export async function editStepInput(
  scope: ServiceScope,
  runId: string,
  stepId: string,
  input: unknown,
  opts?: ControlOpts,
): Promise<ServiceResult<EditStepResult>> {
  const access = await openRun(scope, runId, opts, true);
  if (!access.ok) return access;
  const { run, db } = access.data;

  if (run.state === 'cancelled') return fail('That run was cancelled.', { code: SERVICE_CODES.invalidInput });
  if (!run.plan_id) return fail('That run has no plan to edit.', { code: SERVICE_CODES.invalidInput });
  if (!run.request_id) {
    // Plan versions are unique per request (0250's `uq_ai_plans_request_version`),
    // so a run created without one has nothing to version against.
    return fail('That run was not created from a request, so its plan cannot be edited.', { code: SERVICE_CODES.invalidInput });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('The new step details must be an object.', { code: SERVICE_CODES.invalidInput });
  }

  const loaded = await loadPlanSteps(scope, run.plan_id, { db });
  if (!loaded.ok) return loaded;
  const steps = loaded.data;
  const target = steps.find((s) => s.id === stepId);
  if (!target) return fail('That step is not part of this run.', { code: SERVICE_CODES.notFound });

  const requeue = new Set([stepId, ...collectDependents(steps, stepId).map((s) => s.id)]);

  const planSteps: PlanStepInput[] = steps.map((step) => {
    const carried = !requeue.has(step.id) && (step.status === 'completed' || step.status === 'skipped');
    return {
      key: step.id,
      stepType: step.step_type,
      toolName: step.tool_name,
      description: step.description,
      input: step.id === stepId ? input : step.input_json,
      dependsOn: [...step.dependency_ids],
      condition: step.condition ?? undefined,
      approvalRequired: step.approval_required,
      riskLevel: step.risk_level,
      maxRetries: step.max_retries,
      status: carried ? (step.status as StepState) : 'queued',
      resultJson: carried ? step.result_json : null,
      // A carried-over approval keeps its decision; a requeued one asks again.
      approvalId: carried ? step.approval_id : null,
    };
  });

  const saved = await savePlan(scope, run.request_id, {
    objective: null,
    reasoningSummary: `Edited by a family manager: "${target.description || target.tool_name || target.step_type}".`,
    requiresApproval: planSteps.some((s) => s.approvalRequired === true),
    steps: planSteps,
  }, { db });
  if (!saved.ok) return saved;

  const repointed = await updateRun(scope, runId, {
    plan_id: saved.data.planId,
    state: 'ready',
    status: legacyStatusFor('ready'),
    run_after: new Date().toISOString(),
    completed_at: null,
    error: null,
    current_step_id: null,
  }, { db });
  if (!repointed.ok) return repointed;

  await appendEvent(scope, runId, {
    eventType: 'planned',
    message: `A family manager edited "${target.description || target.tool_name || target.step_type}", so Bubaly re-planned from that step onward.`,
    payload: { plan_id: saved.data.planId, version: saved.data.version, requeued: requeue.size },
  }, { db });
  if (run.request_id) await updateRequest(scope, run.request_id, { status: 'ready', error: null, completed_at: null }, { db });
  await audit(scope, db, 'ai_run.edit_step', runId, { step_id: stepId, plan_id: saved.data.planId, version: saved.data.version });

  return ok({ planId: saved.data.planId, version: saved.data.version, requeuedSteps: requeue.size });
}
