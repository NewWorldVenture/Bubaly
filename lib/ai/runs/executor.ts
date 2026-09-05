// The graph executor - the part of Bubaly that actually does the work.
//
// A run is a dependency graph of steps (§9). This module repeatedly picks every
// step whose dependencies are satisfied, runs the independent ones together,
// records each transition on the run timeline, and stops in exactly one of the
// §10 states. The rules it exists to enforce, all of which are failure modes we
// have already seen in this repo's own AI paths:
//
//   - Nothing is repeated blindly. Every tool call carries an idempotency key
//     derived from (family, run, step, tool), so a retry - or a second cron
//     invocation that recovered an expired lease - re-enters the `ai_tool_calls`
//     ledger instead of creating a second calendar event (§30).
//   - Retries are bounded and only for errors the tool reported as retryable.
//     A denial is not a transport failure and is never retried.
//   - A pending approval PARKS the run. It is not a failure: the work is still
//     valid, it is waiting for a person, and the run resumes on the decision.
//   - The wall clock is a first-class input. Vercel kills the function at
//     `maxDuration`, so the executor stops while it still has time to persist,
//     sets `run_after`, and lets the next continuation pick up exactly where it
//     left off. A half-finished workflow must be reportable as "6 of 8 actions
//     completed", never lost (§29).
//   - A run only says `completed` when nothing failed. Otherwise it says
//     `partially_completed` and the timeline says which steps did not happen.
//
// WHY the port indirection: every rule above is control flow, and control flow
// that can only be exercised against a live Postgres is control flow nobody
// checks. `runGraphWith` takes an `ExecutorPort` - the whole outside world as
// one object - so tests/run-executor.test.ts drives budget exhaustion, approval
// parking, retry exhaustion, cycles and cancellation as pure unit tests.
// `runGraph` is the production wiring of that port over the service client.
import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json, NotificationType } from '@/lib/database.types';
import { backoffDelayMs } from '@/lib/ai/retry';
import { executeTool } from '@/lib/ai/tools/execute';
import type { ToolOutcome } from '@/lib/ai/tools/types';
import { createServiceClient } from '@/lib/supabase/server';
import { describeDbError } from '@/lib/supabase/errors';
import { notify } from '@/lib/services/notifications';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import {
  blockedSteps, describeProgress, findDependencyCycle, isTerminalRunState, legacyStatusFor,
  selectRunnableSteps, summarizeSteps, terminalRunStateFor, type RunState, type StepState,
} from './states';
import {
  appendEvent as storeAppendEvent, heartbeatRun, loadPlanSteps, loadRunActor, loadRunById,
  updateRequest, updateRun as storeUpdateRun, updateStep as storeUpdateStep,
  type RunEventInput, type RunRow, type StepRow,
} from './store';
import { parseVerificationSpec, runVerification, type VerificationOutcome } from './verify';

type RunPatch = Database['public']['Tables']['family_automation_runs']['Update'];
type StepPatch = Database['public']['Tables']['ai_plan_steps']['Update'];

/**
 * A run must be the run of its own request: same family, the plan it names was
 * planned for that request, and the member it acts for is the member who
 * filed the request. Anything else is a forged or corrupted row.
 */
async function runMatchesRequest(db: SupabaseClient<Database>, run: RunSnapshot): Promise<ServiceResult<null>> {
  if (!run.plan_id) return ok(null);
  if (!run.request_id) return fail('This run names a plan but no request, so Bubaly will not act on it.', { code: SERVICE_CODES.denied });
  const [{ data: plan, error: planError }, { data: request, error: requestError }] = await Promise.all([
    db.from('ai_plans').select('id, request_id, family_id').eq('id', run.plan_id).eq('family_id', run.family_id).maybeSingle(),
    db.from('ai_requests').select('id, requested_by_member_id, family_id').eq('id', run.request_id).eq('family_id', run.family_id).maybeSingle(),
  ]);
  if (planError || requestError) {
    console.error('[ai/runs] could not verify the run against its request', planError ?? requestError);
    return fail('Bubaly could not verify this run.', { code: SERVICE_CODES.db, retryable: true });
  }
  if (!plan || !request || plan.request_id !== request.id) {
    return fail('This run does not belong to the request it names, so Bubaly will not act on it.', { code: SERVICE_CODES.denied });
  }
  if ((request.requested_by_member_id ?? null) !== (run.requested_by_member_id ?? null)) {
    return fail('This run would act for someone other than the person who asked, so Bubaly will not act on it.', { code: SERVICE_CODES.denied });
  }
  return ok(null);
}

/** The run fields the graph reasons about. A `Pick` of the real row so the two can never drift. */
export type RunSnapshot = Pick<
  RunRow,
  'id' | 'family_id' | 'plan_id' | 'request_id' | 'state' | 'cancel_requested_at' | 'paused_at'
  | 'requested_by_member_id' | 'attempt' | 'max_attempts' | 'lease_owner'
>;

/** The step fields the graph reasons about. */
export type StepSnapshot = Pick<
  StepRow,
  'id' | 'plan_id' | 'sequence' | 'step_type' | 'tool_name' | 'description' | 'input_json'
  | 'dependency_ids' | 'condition' | 'status' | 'approval_required' | 'approval_id'
  | 'risk_level' | 'retry_count' | 'max_retries' | 'result_json' | 'error'
>;

export type ApprovalSnapshot = { id: string; status: string; editedPayload: unknown };

/** Everything outside the control flow, in one injectable object. */
export type ExecutorPort = {
  loadRun(runId: string): Promise<ServiceResult<RunSnapshot | null>>;
  loadSteps(run: RunSnapshot): Promise<ServiceResult<StepSnapshot[]>>;
  updateRun(run: RunSnapshot, patch: RunPatch): Promise<void>;
  updateStep(run: RunSnapshot, stepId: string, patch: StepPatch): Promise<void>;
  appendEvent(run: RunSnapshot, event: RunEventInput): Promise<void>;
  heartbeat(run: RunSnapshot): Promise<void>;
  /** Re-reads the requester's membership; a failure blocks the run rather than executing with stale authority. */
  scopeFor(run: RunSnapshot): Promise<ServiceResult<ServiceScope>>;
  runTool(
    scope: ServiceScope,
    name: string,
    args: unknown,
    opts: { runId: string; stepId: string; requestId: string | null; idempotencyKey: string; skipTrust: boolean },
  ): Promise<ToolOutcome>;
  requestApproval(scope: ServiceScope, run: RunSnapshot, step: StepSnapshot): Promise<ServiceResult<{ id: string }>>;
  loadApproval(scope: ServiceScope, approvalId: string): Promise<ServiceResult<ApprovalSnapshot | null>>;
  notifyFamily(scope: ServiceScope, input: NotifyStepInput): Promise<ServiceResult<{ created: number }>>;
  verify(scope: ServiceScope, spec: unknown): Promise<ServiceResult<VerificationOutcome>>;
  /**
   * Re-planning with the results gathered so far (§9's `replan` step). Owned by
   * the planner (lib/ai/planner), which is a later slice; until it is wired the
   * executor reports a replan step as blocked instead of pretending it ran.
   */
  replan:
    | ((scope: ServiceScope, run: RunSnapshot, step: StepSnapshot, steps: StepSnapshot[]) => Promise<ServiceResult<{ planId: string }>>)
    | null;
  setRequestState(run: RunSnapshot, state: RunState, error: string | null): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
};

export type RunGraphResult = {
  status: string;
  completed: number;
  failed: number;
  pending: number;
  awaitingApproval: number;
};

/**
 * How many independent steps run at once. Four is the cap §4.3 of the
 * implementation map specifies: enough for parallel retrieval to be worth it,
 * low enough that one run cannot exhaust the connection pool for a household.
 */
export const MAX_STEP_CONCURRENCY = 4;
/** Wall clock kept in reserve so the parking writes themselves always fit. */
export const BUDGET_RESERVE_MS = 8_000;
/** Default slice length when a caller does not say. Comfortably inside a 60 s function. */
export const DEFAULT_BUDGET_MS = 45_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;
/** Safety net: the loop is driven by state changes, so a pass that changes nothing must not spin. */
const MAX_PASSES = 100;

// --- Idempotency ------------------------------------------------------------

/**
 * §30's key composition - household + run + step + operation. Deliberately does
 * NOT include the attempt number: that is the whole point. When a step is
 * retried, the same key reaches the `ai_tool_calls` ledger, so a first attempt
 * that actually succeeded before the response was lost returns its original
 * result instead of writing a second row.
 */
export function stepIdempotencyKey(familyId: string, runId: string, stepId: string, toolName: string): string {
  return createHash('sha256').update([familyId, runId, stepId, toolName].join(' ')).digest('hex');
}

// --- Conditions -------------------------------------------------------------

export type StepCondition = {
  /**
   * A path into `{ deps, dep, input }`, e.g. `deps[0].international`.
   * Positional `deps[i]` is the form a planner can actually write: dependency
   * ids are uuids minted by `savePlan`, so a plan authored in terms of its own
   * step keys cannot name them. `dep.<uuid>` is there for a re-plan, which does
   * know the ids of the steps that already ran.
   */
  path: string;
  eq?: unknown;
  ne?: unknown;
  exists?: boolean;
  gt?: number;
  lt?: number;
  in?: unknown[];
};

function readPath(source: unknown, path: string): unknown {
  const tokens = path.replace(/^\$\.?/, '').split(/[.[\]]+/).filter(Boolean);
  let cursor: unknown = source;
  for (const token of tokens) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(token);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[token];
  }
  return cursor;
}

/**
 * Evaluate a step's `condition` against the results of its dependencies. A
 * condition that does not parse is treated as UNMET rather than met: a step
 * that was supposed to run only for an international trip must not run for a
 * domestic one because the planner wrote a malformed comparison.
 */
export function evaluateCondition(
  condition: unknown,
  context: { deps: unknown[]; dep: Record<string, unknown>; input: unknown },
): { pass: boolean; reason: string } {
  if (condition === null || condition === undefined) return { pass: true, reason: 'no condition' };
  if (typeof condition !== 'object' || Array.isArray(condition)) return { pass: false, reason: 'the condition is not an object' };
  const spec = condition as StepCondition;
  if (typeof spec.path !== 'string' || !spec.path) return { pass: false, reason: 'the condition has no path' };

  const value = readPath(context, spec.path);
  if (spec.exists !== undefined) {
    const present = value !== undefined && value !== null;
    return { pass: present === spec.exists, reason: `${spec.path} ${present ? 'exists' : 'is missing'}` };
  }
  if (spec.eq !== undefined) {
    return { pass: JSON.stringify(value) === JSON.stringify(spec.eq), reason: `${spec.path} = ${JSON.stringify(spec.eq)}` };
  }
  if (spec.ne !== undefined) {
    return { pass: JSON.stringify(value) !== JSON.stringify(spec.ne), reason: `${spec.path} is not ${JSON.stringify(spec.ne)}` };
  }
  if (spec.in !== undefined) {
    const list = Array.isArray(spec.in) ? spec.in : [];
    return { pass: list.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)), reason: `${spec.path} in ${JSON.stringify(list)}` };
  }
  if (spec.gt !== undefined) return { pass: typeof value === 'number' && value > spec.gt, reason: `${spec.path} greater than ${spec.gt}` };
  if (spec.lt !== undefined) return { pass: typeof value === 'number' && value < spec.lt, reason: `${spec.path} less than ${spec.lt}` };
  return { pass: false, reason: 'the condition has no comparison' };
}

// --- Notify steps -----------------------------------------------------------

export type NotifyStepInput = {
  recipients: 'family' | 'managers' | string[];
  type: NotificationType;
  title: string;
  body?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  sendAt?: string | null;
  urgent?: boolean;
};

/**
 * `public.notification_type` is an enum, so an unknown value would be rejected
 * by Postgres after the step already reported success. Steps therefore declare
 * a type from the enum as it exists today and anything else falls back to
 * 'system' - the generic bucket the notification bell already renders.
 */
const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'chore_due', 'medication_due', 'calendar_event', 'school_event', 'sports_event',
  'maintenance_task', 'grocery_reminder', 'document_expiry', 'family_invite', 'system',
];

export function parseNotifyInput(input: unknown): ServiceResult<NotifyStepInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('That notification step has no details to send.', { code: SERVICE_CODES.invalidInput });
  }
  const raw = input as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return fail('That notification step has no title.', { code: SERVICE_CODES.invalidInput });

  let recipients: NotifyStepInput['recipients'] = 'family';
  if (raw.recipients === 'managers' || raw.recipients === 'family') {
    recipients = raw.recipients;
  } else if (Array.isArray(raw.recipients)) {
    const ids = raw.recipients.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (!ids.length) return fail('That notification step names no one to tell.', { code: SERVICE_CODES.invalidInput });
    recipients = ids;
  }

  const type = (NOTIFICATION_TYPES as readonly string[]).includes(String(raw.type)) ? (raw.type as NotificationType) : 'system';
  return ok({
    recipients,
    type,
    title,
    body: typeof raw.body === 'string' ? raw.body : null,
    relatedType: typeof raw.relatedType === 'string' ? raw.relatedType : null,
    relatedId: typeof raw.relatedId === 'string' ? raw.relatedId : null,
    sendAt: typeof raw.sendAt === 'string' ? raw.sendAt : null,
    urgent: raw.urgent === true,
  });
}

// --- Step outcomes ----------------------------------------------------------

type StepDisposition =
  | { kind: 'progressed' }
  | { kind: 'awaiting_approval' }
  | { kind: 'replanned'; planId: string }
  | { kind: 'scheduled'; runAfter: string }
  | { kind: 'out_of_budget' };

/** What a step wrote back, redacted: `ai_plan_steps.result_json` is readable by the whole family. */
function redactResult(summary: string, data: unknown): Json {
  const payload: Record<string, unknown> = { summary };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    // Only the identifiers a later step or a verification needs. Never the row.
    for (const key of ['id', 'ids', 'resource_table', 'resourceTable', 'count', 'verified']) {
      if (record[key] !== undefined) payload[key] = record[key];
    }
  }
  return payload as Json;
}

// --- The graph loop ---------------------------------------------------------

/**
 * Execute a run with an injected port. Returns the state the run is in when
 * this slice ends - which is often not terminal: `ready` (budget spent, resume
 * later), `awaiting_approval` (a person must decide) and `scheduled_followup`
 * (a deliberate wait) are all successful outcomes of one invocation.
 */
export async function runGraphWith(port: ExecutorPort, runId: string, opts?: { budgetMs?: number }): Promise<RunGraphResult> {
  const budgetMs = Math.max(1_000, opts?.budgetMs ?? DEFAULT_BUDGET_MS);
  const deadline = port.now() + budgetMs;
  const empty = { completed: 0, failed: 0, pending: 0, awaitingApproval: 0 };

  const loaded = await port.loadRun(runId);
  if (!loaded.ok) return { status: 'error', ...empty };
  const initial = loaded.data;
  if (!initial) return { status: 'not_found', ...empty };
  if (isTerminalRunState(initial.state as RunState)) return { status: initial.state, ...empty };
  if (initial.paused_at || initial.state === 'paused') return { status: 'paused', ...empty };

  let run = initial;

  // Cancellation wins over everything, including a run mid-flight whose worker
  // died: the executor never resumes work a person has stopped (§45).
  if (run.cancel_requested_at) {
    const steps = await port.loadSteps(run);
    return finalizeCancelled(port, run, steps.ok ? steps.data : []);
  }

  if (!run.plan_id) {
    const message = 'This run has no plan to execute.';
    await port.updateRun(run, {
      state: 'failed', status: legacyStatusFor('failed'), error: message, completed_at: new Date(port.now()).toISOString(),
    });
    await port.appendEvent(run, { eventType: 'run_failed', message });
    await port.setRequestState(run, 'failed', message);
    return { status: 'failed', ...empty };
  }

  const scoped = await port.scopeFor(run);
  if (!scoped.ok) {
    // An inactive or demoted requester must never have their run finished with
    // their old authority - it is blocked for a person to look at, not failed.
    await port.updateRun(run, { state: 'blocked', status: legacyStatusFor('blocked'), error: scoped.error });
    await port.appendEvent(run, { eventType: 'blocked', message: scoped.error });
    await port.setRequestState(run, 'blocked', scoped.error);
    return { status: 'blocked', ...empty };
  }
  const scope = scoped.data;

  const firstSteps = await port.loadSteps(run);
  if (!firstSteps.ok) return { status: 'error', ...empty };
  let steps = firstSteps.data;

  const cycle = findDependencyCycle(steps);
  if (cycle) {
    const message = `This plan's steps depend on each other in a loop (${cycle.join(' -> ')}), so Bubaly stopped instead of running part of it.`;
    await port.updateRun(run, {
      state: 'failed', status: legacyStatusFor('failed'), error: message, completed_at: new Date(port.now()).toISOString(),
    });
    await port.appendEvent(run, { eventType: 'run_failed', message });
    await port.setRequestState(run, 'failed', message);
    return summarize('failed', steps);
  }

  // A step parked on an approval is not runnable, so a decision made while this
  // run was out of the queue has to be folded in before scheduling. The
  // approvals service is what returns the RUN to `ready`; this is what returns
  // its STEP to the graph.
  if (await reconcileApprovals(port, scope, run, steps)) {
    const afterDecisions = await port.loadSteps(run);
    if (!afterDecisions.ok) return { status: 'error', ...empty };
    steps = afterDecisions.data;
  }

  if (run.state !== 'executing') {
    await port.updateRun(run, {
      state: 'executing', status: legacyStatusFor('executing'), started_at: new Date(port.now()).toISOString(),
    });
    run = { ...run, state: 'executing' };
  }
  // Only on the run's first claim: a continuation of the same run must not
  // start the timeline over.
  if (run.attempt <= 1 && steps.length && steps.every((step) => step.status === 'queued' || step.status === 'ready')) {
    await port.appendEvent(run, { eventType: 'run_started', message: `Started ${steps.length} step${steps.length === 1 ? '' : 's'}.` });
    await port.setRequestState(run, 'executing', null);
  }

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    // Pause and cancel arrive as writes from another request, so both are
    // re-read every pass - that is what makes "Cancel" stop a run in flight
    // rather than after it finishes.
    const refreshed = await port.loadRun(runId);
    if (refreshed.ok && refreshed.data) {
      run = refreshed.data;
      if (run.cancel_requested_at) return finalizeCancelled(port, run, steps);
      if (run.paused_at || run.state === 'paused') {
        await port.appendEvent(run, { eventType: 'paused', message: 'Paused - Bubaly stopped after the steps already in flight.' });
        return summarize('paused', steps);
      }
    }

    // Everything downstream of a failure can never run; say so once, then finish.
    const doomed = blockedSteps(steps);
    for (const step of doomed) {
      await port.updateStep(run, step.id, { status: 'blocked', error: 'A step this one depends on did not finish.' });
      await port.appendEvent(run, {
        eventType: 'blocked',
        stepId: step.id,
        message: `Skipped "${describeStep(step)}" because a step it depends on did not finish.`,
      });
    }
    if (doomed.length) {
      const ids = new Set(doomed.map((s) => s.id));
      steps = steps.map((s) => (ids.has(s.id) ? { ...s, status: 'blocked' as StepState } : s));
    }

    const runnable = selectRunnableSteps(steps);
    if (!runnable.length) return finalizeRun(port, run, steps);

    // Stop while there is still time to persist. The run goes back in the queue
    // with `run_after = now`, so the next continuation resumes here.
    if (deadline - port.now() < BUDGET_RESERVE_MS) {
      return parkForContinuation(
        port, run, steps, new Date(port.now()).toISOString(),
        'Bubaly ran out of time in this pass and will pick up the rest shortly.',
      );
    }

    const batch = runnable.slice(0, MAX_STEP_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((step) => runStep(port, scope, run, step, steps, deadline)));

    let parkedApproval = false;
    let replannedTo: string | null = null;
    let scheduledFor: string | null = null;
    let outOfBudget = false;
    for (const [index, result] of settled.entries()) {
      if (result.status === 'rejected') {
        // A throw here is a bug in the executor or the port, not a tool
        // failure; the step is marked failed so the run cannot loop on it.
        const step = batch[index];
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.error('[ai/runs] step threw outside its own error handling', result.reason);
        await port.updateStep(run, step.id, { status: 'failed', error: message, completed_at: new Date(port.now()).toISOString() });
        await port.appendEvent(run, {
          eventType: 'step_failed', stepId: step.id, message: `"${describeStep(step)}" stopped unexpectedly.`, payload: { error: message },
        });
        continue;
      }
      const disposition = result.value;
      if (disposition.kind === 'awaiting_approval') parkedApproval = true;
      if (disposition.kind === 'replanned') replannedTo = disposition.planId;
      if (disposition.kind === 'scheduled') scheduledFor = disposition.runAfter;
      if (disposition.kind === 'out_of_budget') outOfBudget = true;
    }

    await port.heartbeat(run);

    if (replannedTo) {
      run = { ...run, plan_id: replannedTo };
      await port.updateRun(run, { plan_id: replannedTo });
    }

    const reloaded = await port.loadSteps(run);
    if (!reloaded.ok) return summarize('error', steps);
    steps = reloaded.data;

    if (scheduledFor) {
      return parkForContinuation(port, run, steps, scheduledFor, 'Bubaly scheduled the rest of this for later.', 'scheduled_followup');
    }
    if (parkedApproval && !selectRunnableSteps(steps).length) {
      await port.updateRun(run, {
        state: 'awaiting_approval', status: legacyStatusFor('awaiting_approval'), progress: progressJson(steps),
        lease_owner: null, lease_expires_at: null,
      });
      await port.setRequestState(run, 'awaiting_approval', null);
      return summarize('awaiting_approval', steps);
    }
    if (outOfBudget) {
      return parkForContinuation(
        port, run, steps, new Date(port.now()).toISOString(),
        'Bubaly paused between retries and will continue shortly.',
      );
    }
  }

  // Reaching the pass cap means the graph stopped converging; finishing
  // honestly beats spinning until the function is killed.
  return finalizeRun(port, run, steps);
}

/**
 * Fold in approval decisions taken while this run was out of the queue.
 * Returns true when any step changed, so the caller reloads the graph.
 *
 * An approved step goes back to `ready` rather than straight to `executing`:
 * `runStep` re-reads the decision before it acts, which is what keeps a
 * decision that was reversed (expired, cancelled) from being executed on the
 * strength of a stale read.
 */
async function reconcileApprovals(
  port: ExecutorPort,
  scope: ServiceScope,
  run: RunSnapshot,
  steps: readonly StepSnapshot[],
): Promise<boolean> {
  let changed = false;
  for (const step of steps) {
    if (step.status !== 'awaiting_approval' || !step.approval_id) continue;
    const approval = await port.loadApproval(scope, step.approval_id);
    if (!approval.ok || !approval.data) continue;
    const status = approval.data.status;
    if (status === 'pending') continue;

    if (status === 'approved' || status === 'modified') {
      await port.updateStep(run, step.id, { status: 'ready' });
    } else {
      await port.updateStep(run, step.id, {
        status: 'cancelled', error: `The request was ${status}.`, completed_at: new Date(port.now()).toISOString(),
      });
      await port.appendEvent(run, {
        eventType: 'approval_decided',
        stepId: step.id,
        message: `"${describeStep(step)}" was ${status}, so Bubaly did not do it.`,
        payload: { approval_id: step.approval_id, status },
      });
    }
    changed = true;
  }
  return changed;
}

function describeStep(step: StepSnapshot): string {
  return step.description || step.tool_name || step.step_type;
}

function progressJson(steps: readonly StepSnapshot[]): Json {
  const counts = summarizeSteps(steps);
  return { ...counts, summary: describeProgress(counts) } as unknown as Json;
}

function summarize(status: string, steps: readonly StepSnapshot[]): RunGraphResult {
  const counts = summarizeSteps(steps);
  return {
    status,
    completed: counts.completed,
    failed: counts.failed,
    pending: counts.pending,
    awaitingApproval: counts.awaitingApproval,
  };
}

/** Persist exact state and hand the run back to the queue. */
async function parkForContinuation(
  port: ExecutorPort,
  run: RunSnapshot,
  steps: readonly StepSnapshot[],
  runAfter: string,
  message: string,
  state: RunState = 'ready',
): Promise<RunGraphResult> {
  await port.updateRun(run, {
    state,
    status: legacyStatusFor(state),
    run_after: runAfter,
    progress: progressJson(steps),
    lease_owner: null,
    lease_expires_at: null,
  });
  await port.appendEvent(run, {
    eventType: 'followup_scheduled',
    message,
    payload: { run_after: runAfter, progress: describeProgress(summarizeSteps(steps)) },
  });
  await port.setRequestState(run, state, null);
  return summarize(state, steps);
}

async function finalizeCancelled(port: ExecutorPort, run: RunSnapshot, steps: readonly StepSnapshot[]): Promise<RunGraphResult> {
  const stoppable = (status: StepState) =>
    status === 'queued' || status === 'ready' || status === 'awaiting_approval' || status === 'executing';

  // Steps already finished keep their result - a cancelled run still has to
  // report what it did before it stopped.
  for (const step of steps) {
    if (stoppable(step.status)) {
      await port.updateStep(run, step.id, { status: 'cancelled', error: 'Cancelled before this step ran.' });
    }
  }
  const after = steps.map((step) => (stoppable(step.status) ? { ...step, status: 'cancelled' as StepState } : step));
  const counts = summarizeSteps(after);
  await port.updateRun(run, {
    state: 'cancelled',
    status: legacyStatusFor('cancelled'),
    completed_at: new Date(port.now()).toISOString(),
    progress: progressJson(after),
    lease_owner: null,
    lease_expires_at: null,
  });
  await port.appendEvent(run, { eventType: 'cancelled', message: `Cancelled. ${describeProgress(counts)}` });
  await port.setRequestState(run, 'cancelled', null);
  return summarize('cancelled', after);
}

async function finalizeRun(port: ExecutorPort, run: RunSnapshot, steps: readonly StepSnapshot[]): Promise<RunGraphResult> {
  const counts = summarizeSteps(steps);

  // Nothing runnable but something is waiting on a person: not terminal.
  if (counts.awaitingApproval > 0) {
    await port.updateRun(run, {
      state: 'awaiting_approval',
      status: legacyStatusFor('awaiting_approval'),
      progress: progressJson(steps),
      lease_owner: null,
      lease_expires_at: null,
    });
    await port.setRequestState(run, 'awaiting_approval', null);
    return summarize('awaiting_approval', steps);
  }

  const state = terminalRunStateFor(counts);
  const detail = describeProgress(counts);
  await port.updateRun(run, {
    state,
    status: legacyStatusFor(state),
    completed_at: new Date(port.now()).toISOString(),
    progress: progressJson(steps),
    // NOT `summary`: that column is the run's human label ("Weekend plan"),
    // rendered by /dashboard/family-automation, /dashboard/autonomous-family-
    // management and the autopilot panel. The outcome goes in `result`, which
    // 0022 provided for exactly this and which no surface renders as a title.
    result: { state, detail, ...counts } as unknown as Json,
    error: state === 'completed' ? null : detail,
    lease_owner: null,
    lease_expires_at: null,
  });
  await port.appendEvent(run, {
    eventType: state === 'failed' ? 'run_failed' : 'run_completed',
    message: detail,
    payload: { state, ...counts },
  });
  await port.setRequestState(run, state, state === 'completed' ? null : detail);
  return summarize(state, steps);
}

// --- One step ---------------------------------------------------------------

async function runStep(
  port: ExecutorPort,
  scope: ServiceScope,
  run: RunSnapshot,
  step: StepSnapshot,
  allSteps: readonly StepSnapshot[],
  deadline: number,
): Promise<StepDisposition> {
  const byId = new Map(allSteps.map((s) => [s.id, s]));
  const depResults = step.dependency_ids.map((id) => byId.get(id)?.result_json ?? null);
  const depByIdResults: Record<string, unknown> = {};
  for (const id of step.dependency_ids) depByIdResults[id] = byId.get(id)?.result_json ?? null;

  if (step.condition) {
    const decision = evaluateCondition(step.condition, { deps: depResults, dep: depByIdResults, input: step.input_json });
    if (!decision.pass) {
      await port.updateStep(run, step.id, {
        status: 'skipped',
        completed_at: new Date(port.now()).toISOString(),
        result_json: { summary: `Skipped: ${decision.reason} was not met.` } as Json,
      });
      await port.appendEvent(run, {
        eventType: 'step_skipped', stepId: step.id, message: `Skipped "${describeStep(step)}" - ${decision.reason} was not met.`,
      });
      return { kind: 'progressed' };
    }
  }

  // Approval gate. A step the plan marked as needing approval opens its gate
  // BEFORE any work, so the family sees the intent rather than the aftermath.
  // `approval` steps are nothing but this gate.
  let approvedPayload: unknown = null;
  if (step.approval_required || step.step_type === 'approval') {
    if (!step.approval_id) {
      const created = await port.requestApproval(scope, run, step);
      if (!created.ok) return failStep(port, run, step, created.error, created.retryable === true);
      await port.updateStep(run, step.id, { status: 'awaiting_approval', approval_id: created.data.id });
      await port.appendEvent(run, {
        eventType: 'approval_requested',
        stepId: step.id,
        message: `Waiting for someone to approve "${describeStep(step)}".`,
        payload: { approval_id: created.data.id },
      });
      return { kind: 'awaiting_approval' };
    }

    const approval = await port.loadApproval(scope, step.approval_id);
    if (!approval.ok) return failStep(port, run, step, approval.error, true);
    const status = approval.data?.status ?? 'pending';
    if (status === 'pending') {
      if (step.status !== 'awaiting_approval') await port.updateStep(run, step.id, { status: 'awaiting_approval' });
      return { kind: 'awaiting_approval' };
    }
    if (status !== 'approved' && status !== 'modified') {
      await port.updateStep(run, step.id, {
        status: 'cancelled', error: `The request was ${status}.`, completed_at: new Date(port.now()).toISOString(),
      });
      await port.appendEvent(run, {
        eventType: 'approval_decided',
        stepId: step.id,
        message: `"${describeStep(step)}" was ${status}, so Bubaly did not do it.`,
        payload: { approval_id: step.approval_id, status },
      });
      return { kind: 'progressed' };
    }
    approvedPayload = approval.data?.editedPayload ?? null;
    await port.appendEvent(run, {
      eventType: 'approval_decided',
      stepId: step.id,
      message: `"${describeStep(step)}" was approved.`,
      payload: { approval_id: step.approval_id, status },
    });
    if (step.step_type === 'approval') {
      await port.updateStep(run, step.id, {
        status: 'completed', completed_at: new Date(port.now()).toISOString(), result_json: { summary: 'Approved.' } as Json,
      });
      return { kind: 'progressed' };
    }
  }

  await port.updateStep(run, step.id, { status: 'executing', started_at: new Date(port.now()).toISOString() });
  await port.appendEvent(run, {
    eventType: 'step_started', stepId: step.id, toolName: step.tool_name, message: `Started "${describeStep(step)}".`,
  });

  switch (step.step_type) {
    case 'act':
    case 'retrieve':
      return runToolStep(port, scope, run, step, approvedPayload, deadline);
    case 'verify':
      return runVerifyStep(port, scope, run, step);
    case 'notify':
      return runNotifyStep(port, scope, run, step);
    case 'followup':
      return runFollowupStep(port, run, step);
    case 'replan':
      return runReplanStep(port, scope, run, step, allSteps);
    default:
      // `approval` already returned above; anything else is a step type the
      // planner emitted that this executor has no way to perform.
      return failStep(port, run, step, `Bubaly does not know how to run a "${step.step_type}" step.`, false);
  }
}

/**
 * Record a step failure, retrying only when the caller says the error is
 * transient AND the step has retries left. `retry_count` is the ratchet: it is
 * persisted, so a retry budget spans invocations rather than resetting every
 * time the run is re-claimed.
 */
async function failStep(
  port: ExecutorPort,
  run: RunSnapshot,
  step: StepSnapshot,
  error: string,
  retryable: boolean,
): Promise<StepDisposition> {
  const canRetry = retryable && step.retry_count < step.max_retries;
  if (!canRetry) {
    await port.updateStep(run, step.id, { status: 'failed', error, completed_at: new Date(port.now()).toISOString() });
    await port.appendEvent(run, {
      eventType: 'step_failed',
      stepId: step.id,
      toolName: step.tool_name,
      message: `"${describeStep(step)}" failed: ${error}`,
      payload: { retry_count: step.retry_count },
    });
    return { kind: 'progressed' };
  }
  await port.updateStep(run, step.id, { status: 'ready', retry_count: step.retry_count + 1, error });
  await port.appendEvent(run, {
    eventType: 'step_retried',
    stepId: step.id,
    toolName: step.tool_name,
    message: `"${describeStep(step)}" failed and will be tried again (attempt ${step.retry_count + 2} of ${step.max_retries + 1}).`,
    payload: { error, retry_count: step.retry_count + 1 },
  });
  return { kind: 'progressed' };
}

async function runToolStep(
  port: ExecutorPort,
  scope: ServiceScope,
  run: RunSnapshot,
  step: StepSnapshot,
  approvedPayload: unknown,
  deadline: number,
): Promise<StepDisposition> {
  const toolName = step.tool_name;
  if (!toolName) return failStep(port, run, step, 'This step has no tool to call.', false);

  const args = approvedPayload ?? step.input_json;
  const outcome = await port.runTool(scope, toolName, args, {
    runId: run.id,
    stepId: step.id,
    requestId: run.request_id,
    idempotencyKey: stepIdempotencyKey(run.family_id, run.id, step.id, toolName),
    // An approval a person already decided is not re-gated: doing so would open
    // a second approval row for work the family has already said yes to.
    skipTrust: approvedPayload !== null || (step.approval_required && !!step.approval_id),
  });

  if (outcome.status === 'ok') {
    await port.updateStep(run, step.id, {
      status: 'completed',
      completed_at: new Date(port.now()).toISOString(),
      result_json: redactResult(outcome.summary, outcome.data),
      error: null,
    });
    await port.appendEvent(run, {
      eventType: 'step_completed',
      stepId: step.id,
      toolName,
      message: outcome.summary,
      payload: { tool_call_id: outcome.toolCallId, verified: outcome.verified ?? null },
    });
    return { kind: 'progressed' };
  }

  if (outcome.status === 'pending_approval') {
    await port.updateStep(run, step.id, { status: 'awaiting_approval', approval_id: outcome.approvalId ?? null });
    await port.appendEvent(run, {
      eventType: 'approval_requested',
      stepId: step.id,
      toolName,
      message: outcome.summary || `Waiting for someone to approve "${describeStep(step)}".`,
      payload: { approval_id: outcome.approvalId },
    });
    return { kind: 'awaiting_approval' };
  }

  if (outcome.status === 'denied') {
    // A denial is a decision, not a fault: retrying it would ask the trust
    // engine the same question and get the same answer.
    await port.updateStep(run, step.id, {
      status: 'failed', error: outcome.reason, completed_at: new Date(port.now()).toISOString(),
    });
    await port.appendEvent(run, {
      eventType: 'step_failed', stepId: step.id, toolName, message: `Bubaly was not allowed to do that: ${outcome.reason}`,
    });
    return { kind: 'progressed' };
  }

  if (!outcome.retryable || step.retry_count >= step.max_retries) {
    return failStep(port, run, step, outcome.error, false);
  }

  // Bounded backoff. When the wait does not fit in what is left of this
  // invocation, the run is parked instead of sleeping past the deadline - the
  // next continuation picks the step up with its retry count already recorded.
  const delay = backoffDelayMs(step.retry_count + 1, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS, port.random);
  await failStep(port, run, step, outcome.error, true);
  if (port.now() + delay + BUDGET_RESERVE_MS > deadline) return { kind: 'out_of_budget' };
  await port.sleep(delay);
  return { kind: 'progressed' };
}

async function runVerifyStep(port: ExecutorPort, scope: ServiceScope, run: RunSnapshot, step: StepSnapshot): Promise<StepDisposition> {
  const parsed = parseVerificationSpec(step.input_json);
  if (!parsed.ok) return failStep(port, run, step, parsed.error, false);

  const result = await port.verify(scope, parsed.data);
  if (!result.ok) return failStep(port, run, step, result.error, result.retryable === true);

  if (result.data.verified) {
    await port.updateStep(run, step.id, {
      status: 'completed',
      completed_at: new Date(port.now()).toISOString(),
      result_json: { summary: result.data.detail, verified: true } as Json,
    });
    await port.appendEvent(run, {
      eventType: 'verified', stepId: step.id, message: result.data.detail, payload: { checks: result.data.checks } as Json,
    });
    return { kind: 'progressed' };
  }

  // A failed verification is the whole point of §13: the writes happened but
  // the household is not in the state that was promised, so the run must not
  // report success.
  await port.updateStep(run, step.id, {
    status: 'failed',
    error: result.data.detail,
    completed_at: new Date(port.now()).toISOString(),
    result_json: { summary: result.data.detail, verified: false } as Json,
  });
  await port.appendEvent(run, {
    eventType: 'verification_failed', stepId: step.id, message: result.data.detail, payload: { checks: result.data.checks } as Json,
  });
  return { kind: 'progressed' };
}

async function runNotifyStep(port: ExecutorPort, scope: ServiceScope, run: RunSnapshot, step: StepSnapshot): Promise<StepDisposition> {
  const parsed = parseNotifyInput(step.input_json);
  if (!parsed.ok) return failStep(port, run, step, parsed.error, false);

  const sent = await port.notifyFamily(scope, parsed.data);
  if (!sent.ok) return failStep(port, run, step, sent.error, sent.retryable === true);

  const summary = sent.data.created === 0
    ? 'Nobody needed to be told (everyone already had this notification).'
    : `Told ${sent.data.created} ${sent.data.created === 1 ? 'person' : 'people'}: ${parsed.data.title}`;
  await port.updateStep(run, step.id, {
    status: 'completed',
    completed_at: new Date(port.now()).toISOString(),
    result_json: { summary, count: sent.data.created } as Json,
  });
  await port.appendEvent(run, { eventType: 'notified', stepId: step.id, message: summary, payload: { created: sent.data.created } });
  return { kind: 'progressed' };
}

/**
 * A deliberate wait - "check back after the school confirms". The step
 * completes; the RUN is parked at `scheduled_followup` with `run_after` in the
 * future, which is precisely what `claim_ai_runs` looks for.
 */
async function runFollowupStep(port: ExecutorPort, run: RunSnapshot, step: StepSnapshot): Promise<StepDisposition> {
  const raw = (step.input_json ?? {}) as Record<string, unknown>;
  const explicit = typeof raw.runAfter === 'string' ? Date.parse(raw.runAfter) : Number.NaN;
  const minutes = typeof raw.delayMinutes === 'number' && Number.isFinite(raw.delayMinutes)
    ? Math.max(1, Math.round(raw.delayMinutes))
    : null;
  const at = Number.isFinite(explicit) ? explicit : port.now() + (minutes ?? 60) * 60_000;
  if (at <= port.now()) return failStep(port, run, step, 'That follow-up is scheduled for a time that has already passed.', false);

  const runAfter = new Date(at).toISOString();
  await port.updateStep(run, step.id, {
    status: 'completed',
    completed_at: new Date(port.now()).toISOString(),
    result_json: { summary: `Scheduled to continue at ${runAfter}.` } as Json,
  });
  await port.appendEvent(run, {
    eventType: 'followup_scheduled', stepId: step.id, message: `Bubaly will continue this at ${runAfter}.`, payload: { run_after: runAfter },
  });
  return { kind: 'scheduled', runAfter };
}

async function runReplanStep(
  port: ExecutorPort,
  scope: ServiceScope,
  run: RunSnapshot,
  step: StepSnapshot,
  steps: readonly StepSnapshot[],
): Promise<StepDisposition> {
  if (!port.replan) {
    // Honest refusal: the plan asked for a decision this deployment cannot
    // make, so the branch is blocked and the run reports partial completion
    // rather than silently dropping the rest of the workflow.
    await port.updateStep(run, step.id, {
      status: 'blocked', error: 'Re-planning is not available for this run.', completed_at: new Date(port.now()).toISOString(),
    });
    await port.appendEvent(run, { eventType: 'blocked', stepId: step.id, message: 'Bubaly could not re-plan the rest of this on its own.' });
    return { kind: 'progressed' };
  }

  const replanned = await port.replan(scope, run, step, [...steps]);
  if (!replanned.ok) return failStep(port, run, step, replanned.error, replanned.retryable === true);

  await port.updateStep(run, step.id, {
    status: 'completed',
    completed_at: new Date(port.now()).toISOString(),
    result_json: { summary: 'Re-planned the rest of this run.' } as Json,
  });
  await port.appendEvent(run, {
    eventType: 'planned',
    stepId: step.id,
    message: 'Bubaly re-planned the rest of this run with what it had learned.',
    payload: { plan_id: replanned.data.planId },
  });
  return { kind: 'replanned', planId: replanned.data.planId };
}

// --- Production wiring ------------------------------------------------------

/** The trust domain an approval row is filed under, taken from the tool's dotted prefix when it names one. */
function approvalDomainFor(step: StepSnapshot): string {
  const prefix = (step.tool_name ?? '').split('.')[0];
  const known = [
    'calendar', 'scheduling', 'tasks', 'chores', 'shopping', 'meal_planning',
    'messaging', 'finances', 'travel', 'documents', 'home_maintenance',
  ];
  return known.includes(prefix) ? prefix : 'scheduling';
}

/**
 * Build the real port over a service client. Every statement filters
 * `family_id` explicitly - the service client bypasses RLS, so the tenancy
 * boundary here is the code, not the database.
 */
export function createExecutorPort(db: SupabaseClient<Database>): ExecutorPort {
  const scopeCache = new Map<string, ServiceScope>();

  // A minimal system scope for the bookkeeping writes, which only ever need the
  // family id and the service client. The EXECUTING scope (with the requester's
  // re-read role and the family's real timezone) is built by `scopeFor`.
  const systemScope = (run: RunSnapshot): ServiceScope => ({
    db,
    familyId: run.family_id,
    userId: null,
    memberId: run.requested_by_member_id,
    role: 'system',
    actorKind: 'ai',
    tz: 'UTC',
    runId: run.id,
    requestId: run.request_id,
  });

  return {
    async loadRun(runId) {
      const res = await loadRunById(db, runId);
      if (!res.ok) return res;
      return ok((res.data as RunSnapshot | null) ?? null);
    },
    async loadSteps(run) {
      if (!run.plan_id) return ok([]);
      const res = await loadPlanSteps(systemScope(run), run.plan_id, { db });
      if (!res.ok) return res;
      return ok(res.data as StepSnapshot[]);
    },
    async updateRun(run, patch) {
      await storeUpdateRun(systemScope(run), run.id, patch, { db });
    },
    async updateStep(run, stepId, patch) {
      await storeUpdateStep(systemScope(run), stepId, patch, { db });
    },
    async appendEvent(run, event) {
      await storeAppendEvent(systemScope(run), run.id, event, { db });
    },
    async heartbeat(run) {
      if (run.lease_owner) await heartbeatRun(db, run.id, run.lease_owner);
    },
    async scopeFor(run) {
      const cached = scopeCache.get(run.id);
      if (cached) return ok(cached);
      const actor = await loadRunActor(db, run.family_id, run.requested_by_member_id);
      if (!actor.ok) return actor;
      // Defense in depth behind the 0252 INSERT policy: a run that names a
      // plan must be the run of that plan's request, and must act for the
      // member who filed that request. A row that points at someone else's
      // plan (or at a plan with no request) is blocked before any tool runs.
      const consistent = await runMatchesRequest(db, run);
      if (!consistent.ok) return consistent;
      const scope: ServiceScope = {
        db,
        familyId: run.family_id,
        userId: actor.data.userId,
        memberId: actor.data.memberId,
        // The run acts with the requester's role as it is NOW, so a demotion
        // between invocations takes effect on the very next slice.
        role: actor.data.role ?? 'system',
        actorKind: 'ai',
        tz: actor.data.timezone,
        runId: run.id,
        requestId: run.request_id,
      };
      scopeCache.set(run.id, scope);
      return ok(scope);
    },
    runTool(scope, name, args, opts) {
      return executeTool(scope, name, args, {
        runId: opts.runId,
        stepId: opts.stepId,
        requestId: opts.requestId,
        idempotencyKey: opts.idempotencyKey,
        skipTrust: opts.skipTrust,
      });
    },
    async requestApproval(scope, run, step) {
      const input = (step.input_json ?? {}) as Record<string, unknown>;
      const consequences = Array.isArray(input.consequences) ? input.consequences : [];
      const { data, error } = await db
        .from('approval_requests')
        .insert({
          family_id: run.family_id,
          domain: approvalDomainFor(step),
          capability: 'automate',
          requested_by_kind: 'ai',
          requested_by_member_id: run.requested_by_member_id,
          agent: 'concierge',
          title: describeStep(step),
          summary: typeof input.summary === 'string' ? input.summary : null,
          payload: { kind: 'plan_steps', run_id: run.id, step_ids: [step.id], input: step.input_json } as Json,
          payload_kind: 'plan_steps',
          run_id: run.id,
          request_id: run.request_id,
          plan_step_id: step.id,
          plan_step_ids: [step.id],
          consequences: consequences as Json,
          status: 'pending',
          priority: step.risk_level === 'high' ? 'high' : 'normal',
        })
        .select('id')
        .single();
      if (error || !data) {
        console.error('[ai/runs] failed to open an approval for a step', error);
        return fail(describeDbError(error, 'Bubaly could not ask anyone to approve that.'), {
          code: SERVICE_CODES.db, retryable: true,
        });
      }
      return ok({ id: data.id });
    },
    async loadApproval(scope, approvalId) {
      const { data, error } = await db
        .from('approval_requests')
        .select('id, status, edited_payload')
        .eq('id', approvalId)
        .eq('family_id', scope.familyId)
        .maybeSingle();
      if (error) {
        console.error('[ai/runs] failed to read an approval', error);
        return fail(describeDbError(error, 'Bubaly could not read that approval.'), { code: SERVICE_CODES.db, retryable: true });
      }
      if (!data) return ok(null);
      return ok({ id: data.id, status: data.status, editedPayload: data.edited_payload ?? null });
    },
    async notifyFamily(scope, input) {
      const res = await notify(scope, input);
      if (!res.ok) return res;
      return ok({ created: res.data.created });
    },
    async verify(scope, spec) {
      const parsed = parseVerificationSpec(spec);
      if (!parsed.ok) return parsed;
      return runVerification(scope, parsed.data);
    },
    // Wired by the planner slice (P2-02); null here is a real, handled state,
    // not a stub: a replan step blocks and the run reports partial completion.
    replan: null,
    async setRequestState(run, state, error) {
      if (!run.request_id) return;
      const terminal = state === 'completed' || state === 'partially_completed' || state === 'failed' || state === 'cancelled';
      await updateRequest(
        systemScope(run),
        run.request_id,
        {
          // `ai_requests.status` has no 'paused' value (0250); a paused run is
          // blocked from the request's point of view - it is waiting on a person.
          status: state === 'paused' ? 'blocked' : state,
          error,
          ...(terminal ? { completed_at: new Date().toISOString() } : {}),
        },
        { db },
      );
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
    random: Math.random,
  };
}

/**
 * Execute a run. This is the entry point the cron, the continuation helper and
 * the run controls all use; `db` may be supplied when the caller already holds
 * a service client (the cron claims a batch with one).
 */
export async function runGraph(runId: string, opts?: { budgetMs?: number; db?: SupabaseClient<Database> }): Promise<RunGraphResult> {
  const db = opts?.db ?? createServiceClient();
  return runGraphWith(createExecutorPort(db), runId, { budgetMs: opts?.budgetMs });
}
