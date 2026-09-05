// Typed persistence for the run spine: request → plan → steps → run → events.
//
// WHY every write here goes through the service client: 0250 gives members
// SELECT and nothing else on `ai_plans`, `ai_plan_steps`, `ai_run_events` and
// `ai_tool_calls`. That is deliberate — a member who could INSERT a plan step
// could inject `finances.updateBudget` into a parent's run and have the
// executor perform it with the run's authority, and a member who could INSERT
// a run event could forge the "Completed by Bubaly" timeline. So the bookkeeping
// client is chosen by `ledgerClient()` rather than taken from the caller's
// scope, and every statement still filters `family_id` explicitly because the
// service client bypasses RLS entirely.
//
// `ai_requests` is the one exception: 0250 keeps a narrow INSERT policy so a
// person can file a request from the browser or the mobile app, so
// `createRequest` uses the caller's own client and lets RLS check the row.
//
// The `opts.db` seam on every function exists because the executor and the cron
// already hold a service client — creating a second one per call would open a
// new connection for every event row — and because it lets the control-flow
// tests drive the store against a fake client instead of a live database.
import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AiRequestKind, AiRiskLevel, AiRunEventType, AiRunType, AiStepType, Database, Json, Tables,
} from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import {
  findDependencyCycle, legacyStatusFor, type RunState, type StepState,
} from './states';

export type RunRow = Tables<'family_automation_runs'>;
export type StepRow = Tables<'ai_plan_steps'>;
export type PlanRow = Tables<'ai_plans'>;
export type RunEventRow = Tables<'ai_run_events'>;
export type RequestRow = Tables<'ai_requests'>;

export type StoreOpts = { db?: SupabaseClient<Database> };

/**
 * The client that may write the AI ledgers. A `system` scope (cron, executor)
 * already carries the service client, so reuse it; anything else gets a fresh
 * one, because a member's client would be refused by RLS.
 */
export function ledgerClient(scope: ServiceScope, opts?: StoreOpts): SupabaseClient<Database> {
  if (opts?.db) return opts.db;
  if (scope.actorKind === 'system') return scope.db;
  return createServiceClient();
}

function nowIso(scope: Pick<ServiceScope, 'now'>): string {
  return (scope.now ?? new Date()).toISOString();
}

// ─── Requests ───────────────────────────────────────────────────────────────

export type CreateRequestInput = {
  requestText: string;
  kind: string;
  conversationId?: string | null;
  interpretedIntent?: string | null;
  contextSnapshot?: unknown;
  priority?: string;
};

const REQUEST_KINDS: readonly AiRequestKind[] = ['concierge', 'feature', 'routine', 'trigger', 'handle_it'];

/**
 * File a request. `priority` arrives as a string from callers that speak the
 * approval vocabulary ('low' | 'normal' | 'high'); the column is a smallint, so
 * it is mapped here rather than pushed onto every caller.
 *
 * `contextSnapshot` is written to `ai_request_context`, never to `ai_requests`:
 * the snapshot can carry finance rows and another member's medical detail, and
 * only that table's policy restricts reads to the requester and managers.
 */
export async function createRequest(
  scope: ServiceScope,
  input: CreateRequestInput,
  opts?: StoreOpts,
): Promise<ServiceResult<{ id: string }>> {
  const text = input.requestText.trim();
  if (!text) return fail('Tell Bubaly what you need.', { code: SERVICE_CODES.invalidInput });

  const kind = (REQUEST_KINDS as readonly string[]).includes(input.kind) ? (input.kind as AiRequestKind) : 'concierge';
  const db = opts?.db ?? scope.db;

  const { data, error } = await db
    .from('ai_requests')
    .insert({
      family_id: scope.familyId,
      conversation_id: input.conversationId ?? null,
      requested_by: scope.userId,
      requested_by_member_id: scope.memberId,
      kind,
      request_text: text,
      interpreted_intent: input.interpretedIntent ?? null,
      status: 'queued',
      priority: priorityToSmallint(input.priority),
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[ai/runs] failed to create the request', error);
    return fail(describeDbError(error, 'Bubaly could not record that request.'), { code: SERVICE_CODES.db, retryable: true });
  }

  if (input.contextSnapshot !== undefined) {
    const ledger = ledgerClient(scope, opts);
    const { error: ctxError } = await ledger
      .from('ai_request_context')
      .upsert({ request_id: data.id, family_id: scope.familyId, snapshot: (input.contextSnapshot ?? {}) as Json }, { onConflict: 'request_id' });
    // A missing snapshot degrades the answer; it must not lose the request the
    // person already made, so this is logged and reported, not fatal.
    if (ctxError) console.error('[ai/runs] failed to persist the request context', ctxError);
  }

  return ok({ id: data.id });
}

function priorityToSmallint(priority?: string): number {
  switch (priority) {
    case 'high':
    case 'urgent':
      return 2;
    case 'low':
      return -1;
    default:
      return 0;
  }
}

export async function updateRequest(
  scope: ServiceScope,
  requestId: string,
  patch: Database['public']['Tables']['ai_requests']['Update'],
  opts?: StoreOpts,
): Promise<ServiceResult<null>> {
  const { error } = await ledgerClient(scope, opts)
    .from('ai_requests')
    .update(patch)
    .eq('id', requestId)
    .eq('family_id', scope.familyId);
  if (error) {
    console.error('[ai/runs] failed to update the request', error);
    return fail(describeDbError(error, 'Bubaly could not update that request.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok(null);
}

// ─── Plans and steps ────────────────────────────────────────────────────────

export type PlanStepInput = {
  /** Planner-local identifier; `dependsOn` refers to these, never to uuids. */
  key: string;
  stepType: AiStepType;
  toolName?: string | null;
  description?: string | null;
  input?: unknown;
  dependsOn?: string[];
  condition?: unknown;
  approvalRequired?: boolean;
  riskLevel?: AiRiskLevel;
  maxRetries?: number;
  /** Carried over by `editStepInput` so already-finished work is not repeated. */
  status?: StepState;
  resultJson?: unknown;
  approvalId?: string | null;
};

export type PlanInput = {
  objective?: string | null;
  reasoningSummary?: string | null;
  riskLevel?: AiRiskLevel;
  requiresApproval?: boolean;
  plannerModel?: string | null;
  plannerPromptVersion?: string | null;
  steps: PlanStepInput[];
};

/** Steps that do nothing without a tool to call — validated before anything is written. */
const TOOL_REQUIRED_STEP_TYPES: readonly AiStepType[] = ['act', 'retrieve'];

/**
 * Persist a plan version and its steps.
 *
 * Versioned rather than mutated: editing a step (§13's "Edit" on an approval)
 * writes version N+1 and supersedes N, so the family can always see the plan
 * they actually reviewed. Step ids are generated here instead of being read
 * back after insert, because `dependency_ids` holds sibling uuids and resolving
 * the planner's keys after the fact would need a second round trip per step.
 *
 * Rejects a cyclic graph up front: a plan where B waits on C and C waits on B
 * has no runnable step, so the executor would find nothing to do and report a
 * run "completed" that performed zero actions.
 */
export async function savePlan(
  scope: ServiceScope,
  requestId: string,
  plan: PlanInput,
  opts?: StoreOpts,
): Promise<ServiceResult<{ planId: string; version: number; stepIds: Record<string, string> }>> {
  if (!plan.steps.length) return fail('A plan needs at least one step.', { code: SERVICE_CODES.invalidInput });

  const stepIds: Record<string, string> = {};
  for (const step of plan.steps) {
    if (!step.key) return fail('Every plan step needs a key.', { code: SERVICE_CODES.invalidInput });
    if (stepIds[step.key]) return fail(`Duplicate plan step key "${step.key}".`, { code: SERVICE_CODES.invalidInput });
    if (TOOL_REQUIRED_STEP_TYPES.includes(step.stepType) && !step.toolName) {
      return fail(`Step "${step.key}" is a ${step.stepType} step with no tool.`, { code: SERVICE_CODES.invalidInput });
    }
    stepIds[step.key] = randomUUID();
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!stepIds[dep]) return fail(`Step "${step.key}" depends on unknown step "${dep}".`, { code: SERVICE_CODES.invalidInput });
    }
  }
  const cycle = findDependencyCycle(
    plan.steps.map((s) => ({ id: s.key, status: 'queued' as StepState, dependency_ids: s.dependsOn ?? [] })),
  );
  if (cycle) return fail(`The plan's steps depend on each other in a loop (${cycle.join(' → ')}).`, { code: SERVICE_CODES.invalidInput });

  const db = ledgerClient(scope, opts);

  const { data: prior, error: priorError } = await db
    .from('ai_plans')
    .select('id, version')
    .eq('family_id', scope.familyId)
    .eq('request_id', requestId)
    .order('version', { ascending: false })
    .limit(1);
  if (priorError) {
    console.error('[ai/runs] failed to read the previous plan version', priorError);
    return fail(describeDbError(priorError, 'Bubaly could not read the previous plan.'), { code: SERVICE_CODES.db, retryable: true });
  }
  const version = (prior?.[0]?.version ?? 0) + 1;

  if (version > 1) {
    const { error: supersedeError } = await db
      .from('ai_plans')
      .update({ status: 'superseded' })
      .eq('family_id', scope.familyId)
      .eq('request_id', requestId)
      .in('status', ['draft', 'approved', 'executing']);
    if (supersedeError) {
      console.error('[ai/runs] failed to supersede the previous plan version', supersedeError);
      return fail(describeDbError(supersedeError, 'Bubaly could not replace the previous plan.'), { code: SERVICE_CODES.db, retryable: true });
    }
  }

  const { data: planRow, error: planError } = await db
    .from('ai_plans')
    .insert({
      family_id: scope.familyId,
      request_id: requestId,
      version,
      objective: plan.objective ?? null,
      reasoning_summary: plan.reasoningSummary ?? null,
      status: 'approved',
      risk_level: plan.riskLevel ?? 'low',
      estimated_actions: plan.steps.filter((s) => s.stepType === 'act').length,
      requires_approval: plan.requiresApproval ?? plan.steps.some((s) => s.approvalRequired === true),
      planner_model: plan.plannerModel ?? null,
      planner_prompt_version: plan.plannerPromptVersion ?? null,
    })
    .select('id')
    .single();
  if (planError || !planRow) {
    console.error('[ai/runs] failed to write the plan', planError);
    return fail(describeDbError(planError, 'Bubaly could not save that plan.'), { code: SERVICE_CODES.db, retryable: true });
  }

  const rows = plan.steps.map((step, index) => ({
    id: stepIds[step.key],
    family_id: scope.familyId,
    plan_id: planRow.id,
    sequence: index,
    step_type: step.stepType,
    tool_name: step.toolName ?? null,
    description: step.description ?? null,
    input_json: (step.input ?? {}) as Json,
    dependency_ids: (step.dependsOn ?? []).map((key) => stepIds[key]),
    condition: (step.condition ?? null) as Json | null,
    status: step.status ?? ('queued' as StepState),
    approval_required: step.approvalRequired ?? false,
    approval_id: step.approvalId ?? null,
    risk_level: step.riskLevel ?? 'low',
    max_retries: step.maxRetries ?? 2,
    result_json: (step.resultJson ?? null) as Json | null,
  }));

  const { error: stepsError } = await db.from('ai_plan_steps').insert(rows);
  if (stepsError) {
    console.error('[ai/runs] failed to write the plan steps', stepsError);
    return fail(describeDbError(stepsError, 'Bubaly could not save the plan steps.'), { code: SERVICE_CODES.db, retryable: true });
  }

  return ok({ planId: planRow.id, version, stepIds });
}

export async function loadPlanSteps(
  scope: ServiceScope,
  planId: string,
  opts?: StoreOpts,
): Promise<ServiceResult<StepRow[]>> {
  const { data, error } = await ledgerClient(scope, opts)
    .from('ai_plan_steps')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('plan_id', planId)
    .order('sequence', { ascending: true });
  if (error) {
    console.error('[ai/runs] failed to load the plan steps', error);
    return fail(describeDbError(error, 'Bubaly could not read the plan.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok((data ?? []) as StepRow[]);
}

export async function updateStep(
  scope: ServiceScope,
  stepId: string,
  patch: Database['public']['Tables']['ai_plan_steps']['Update'],
  opts?: StoreOpts,
): Promise<ServiceResult<null>> {
  const { error } = await ledgerClient(scope, opts)
    .from('ai_plan_steps')
    .update(patch)
    .eq('id', stepId)
    .eq('family_id', scope.familyId);
  if (error) {
    console.error('[ai/runs] failed to update a plan step', error);
    return fail(describeDbError(error, 'Bubaly could not update that step.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok(null);
}

// ─── Runs ───────────────────────────────────────────────────────────────────

export type CreateRunInput = {
  requestId?: string | null;
  planId?: string | null;
  runType: string;
  summary?: string | null;
  /** §30 run-level dedupe: a routine firing twice for the same day reuses the run. */
  idempotencyKey?: string | null;
  state?: RunState;
  runAfter?: string | null;
};

const RUN_TYPES: readonly AiRunType[] = ['concierge', 'routine', 'trigger', 'handle_it', 'concierge_plan'];

/**
 * Create (or re-find) the run that will execute a plan.
 *
 * `idempotencyKey` is honoured against the 0250 unique index rather than by a
 * read-then-write: two cron invocations firing the same routine at the same
 * second both reach the INSERT, and exactly one wins. The loser reads the
 * winner's row back instead of starting a second run over the same plan.
 */
export async function createRun(
  scope: ServiceScope,
  input: CreateRunInput,
  opts?: StoreOpts,
): Promise<ServiceResult<{ id: string }>> {
  const db = ledgerClient(scope, opts);
  const runType = (RUN_TYPES as readonly string[]).includes(input.runType) ? (input.runType as AiRunType) : 'concierge';
  const state: RunState = input.state ?? 'ready';

  const { data, error } = await db
    .from('family_automation_runs')
    .insert({
      family_id: scope.familyId,
      request_id: input.requestId ?? null,
      plan_id: input.planId ?? null,
      requested_by_member_id: scope.memberId,
      created_by: scope.userId,
      run_type: runType,
      state,
      status: legacyStatusFor(state),
      summary: input.summary ?? null,
      trigger_type: runType,
      idempotency_key: input.idempotencyKey ?? null,
      run_after: input.runAfter ?? nowIso(scope),
    })
    .select('id')
    .single();

  if (data) return ok({ id: data.id });

  if (error?.code === '23505' && input.idempotencyKey) {
    const { data: existing, error: readError } = await db
      .from('family_automation_runs')
      .select('id')
      .eq('family_id', scope.familyId)
      .eq('idempotency_key', input.idempotencyKey)
      .maybeSingle();
    if (existing) return ok({ id: existing.id });
    console.error('[ai/runs] duplicate run key with no matching row', readError);
  }

  console.error('[ai/runs] failed to create the run', error);
  return fail(describeDbError(error, 'Bubaly could not start that run.'), { code: SERVICE_CODES.db, retryable: true });
}

export async function loadRun(
  scope: ServiceScope,
  runId: string,
  opts?: StoreOpts,
): Promise<ServiceResult<RunRow | null>> {
  const { data, error } = await ledgerClient(scope, opts)
    .from('family_automation_runs')
    .select('*')
    .eq('id', runId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) {
    console.error('[ai/runs] failed to load the run', error);
    return fail(describeDbError(error, 'Bubaly could not read that run.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok((data as RunRow | null) ?? null);
}

/**
 * Load a run by id without knowing its family first. Used by the cron and by
 * `continueRun`, which receive an id from the claim RPC and must then discover
 * which family's scope to build. Every subsequent statement filters on the
 * family this returns.
 */
export async function loadRunById(
  db: SupabaseClient<Database>,
  runId: string,
): Promise<ServiceResult<RunRow | null>> {
  const { data, error } = await db.from('family_automation_runs').select('*').eq('id', runId).maybeSingle();
  if (error) {
    console.error('[ai/runs] failed to load the run by id', error);
    return fail(describeDbError(error, 'Bubaly could not read that run.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok((data as RunRow | null) ?? null);
}

export async function updateRun(
  scope: ServiceScope,
  runId: string,
  patch: Database['public']['Tables']['family_automation_runs']['Update'],
  opts?: StoreOpts,
): Promise<ServiceResult<null>> {
  const { error } = await ledgerClient(scope, opts)
    .from('family_automation_runs')
    .update(patch)
    .eq('id', runId)
    .eq('family_id', scope.familyId);
  if (error) {
    console.error('[ai/runs] failed to update the run', error);
    return fail(describeDbError(error, 'Bubaly could not update that run.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok(null);
}

// ─── Leases ─────────────────────────────────────────────────────────────────

export type ClaimedRun = { id: string; familyId: string; leaseOwner: string | null };

/**
 * Lease a batch of due runs through the 0250 RPC. `for update skip locked`
 * inside the function is what makes two overlapping cron invocations — Vercel's
 * daily trigger and the five-minute GitHub dispatcher — unable to receive the
 * same run.
 */
export async function claimRuns(
  db: SupabaseClient<Database>,
  limit = 10,
  leaseSeconds = 120,
): Promise<ServiceResult<ClaimedRun[]>> {
  const { data, error } = await db.rpc('claim_ai_runs', { p_limit: limit, p_lease_seconds: leaseSeconds });
  if (error) {
    console.error('[ai/runs] claim_ai_runs failed', error);
    return fail(describeDbError(error, 'Bubaly could not pick up any runs.'), { code: SERVICE_CODES.db, retryable: true });
  }
  const ids = (data ?? []) as string[];
  if (!ids.length) return ok([]);

  const { data: rows, error: readError } = await db
    .from('family_automation_runs')
    .select('id, family_id, lease_owner')
    .in('id', ids);
  if (readError) {
    console.error('[ai/runs] failed to read the claimed runs', readError);
    return fail(describeDbError(readError, 'Bubaly could not read the claimed runs.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok((rows ?? []).map((r) => ({ id: r.id, familyId: r.family_id, leaseOwner: r.lease_owner })));
}

/**
 * Lease ONE run by id.
 *
 * `claim_ai_runs` selects by due-ness, not by id, so it cannot be used to pick
 * up a specific run: asking it for one run would lease whichever run happens to
 * be oldest — possibly another family's — and then drop it unexecuted with its
 * `attempt` already burned. This does the same thing the RPC does, for one row:
 * the guard on `attempt` makes the claim atomic (the second writer's WHERE no
 * longer matches once the first has incremented it), and the lease predicate
 * keeps a live worker's run from being stolen.
 */
export async function claimRun(
  db: SupabaseClient<Database>,
  runId: string,
  leaseSeconds = 120,
): Promise<ServiceResult<{ claimed: boolean; run: RunRow | null; leaseOwner: string | null }>> {
  const current = await loadRunById(db, runId);
  if (!current.ok) return current;
  const run = current.data;
  if (!run) return fail('That run no longer exists.', { code: SERVICE_CODES.notFound });

  const now = Date.now();
  const leaseHeld = !!run.lease_expires_at && new Date(run.lease_expires_at).getTime() > now;
  // `run_after` is honoured here for the same reason `claim_ai_runs` filters on
  // it: a run parked at `scheduled_followup` carries the follow-up's due time,
  // and an interactive continuation (a resume, a re-run of another step, the
  // kick after an answer) must not run "check back in three days" today. A
  // `run_after` the row cannot parse counts as due, so a bad timestamp can
  // never strand a run.
  const dueAt = run.run_after ? Date.parse(run.run_after) : Number.NaN;
  const due = !Number.isFinite(dueAt) || dueAt <= now;
  const claimable = (run.state === 'ready' || run.state === 'scheduled_followup')
    && !run.cancel_requested_at
    && !leaseHeld
    && due
    && run.attempt < run.max_attempts;
  if (!claimable) return ok({ claimed: false, run, leaseOwner: null });

  const leaseOwner = randomUUID();
  const { data, error } = await db
    .from('family_automation_runs')
    .update({
      state: 'executing',
      status: legacyStatusFor('executing'),
      attempt: run.attempt + 1,
      lease_owner: leaseOwner,
      lease_expires_at: new Date(now + leaseSeconds * 1000).toISOString(),
      started_at: run.started_at ?? new Date(now).toISOString(),
    })
    .eq('id', runId)
    .eq('family_id', run.family_id)
    .eq('attempt', run.attempt)
    .in('state', ['ready', 'scheduled_followup'])
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[ai/runs] failed to lease the run', error);
    return fail(describeDbError(error, 'Bubaly could not pick that run up.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!data) return ok({ claimed: false, run, leaseOwner: null });
  return ok({ claimed: true, run: data as RunRow, leaseOwner });
}

/** Extend our own lease. Guarded by the token so a recovered-from-the-dead worker cannot extend a lease it no longer owns. */
export async function heartbeatRun(
  db: SupabaseClient<Database>,
  runId: string,
  leaseOwner: string,
  leaseSeconds = 120,
): Promise<boolean> {
  const { data, error } = await db
    .from('family_automation_runs')
    .update({ lease_expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString() })
    .eq('id', runId)
    .eq('lease_owner', leaseOwner)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[ai/runs] heartbeat failed', error);
    return false;
  }
  return !!data;
}

/** Hand the run back so the next invocation can pick it up immediately. */
export async function releaseRun(
  db: SupabaseClient<Database>,
  runId: string,
  leaseOwner: string,
): Promise<void> {
  const { error } = await db
    .from('family_automation_runs')
    .update({ lease_owner: null, lease_expires_at: null })
    .eq('id', runId)
    .eq('lease_owner', leaseOwner);
  if (error) console.error('[ai/runs] failed to release the lease', error);
}

// ─── Events ─────────────────────────────────────────────────────────────────

export type RunEventInput = {
  eventType: AiRunEventType;
  stepId?: string | null;
  toolName?: string | null;
  message: string;
  payload?: unknown;
  requestId?: string | null;
};

/**
 * Append to the run timeline. Never throws and never returns a failure: this is
 * the §17 UI and the §33 telemetry, and losing an event must not abort the work
 * the event describes. Failures are logged so they are visible in the platform
 * logs rather than silently dropped.
 *
 * Payloads are written verbatim, so callers must keep prompt text, context
 * slices and raw rows out of them (0250's header): the table is readable by
 * every member of the family.
 */
export async function appendEvent(
  scope: ServiceScope,
  runId: string,
  event: RunEventInput,
  opts?: StoreOpts,
): Promise<void> {
  const { error } = await ledgerClient(scope, opts)
    .from('ai_run_events')
    .insert({
      family_id: scope.familyId,
      run_id: runId,
      request_id: event.requestId ?? scope.requestId ?? null,
      step_id: event.stepId ?? null,
      event_type: event.eventType,
      tool_name: event.toolName ?? null,
      message: event.message,
      payload: (event.payload ?? {}) as Json,
      actor_kind: scope.actorKind === 'member' ? 'member' : scope.actorKind === 'system' ? 'system' : 'ai',
      actor_member_id: scope.memberId,
    });
  if (error) console.error('[ai/runs] failed to append a run event', error);
}

// ─── Read model ─────────────────────────────────────────────────────────────

export type RunDetail = {
  run: RunRow;
  plan: PlanRow | null;
  steps: StepRow[];
  events: RunEventRow[];
};

/**
 * The run detail read (§17). Uses the CALLER's client on purpose: a member
 * opening a run page should see exactly what RLS lets them see, and a run from
 * another family must come back as "not found" rather than as data.
 */
export async function loadRunDetail(
  scope: ServiceScope,
  runId: string,
  opts?: { db?: SupabaseClient<Database>; eventLimit?: number },
): Promise<ServiceResult<RunDetail | null>> {
  const db = opts?.db ?? scope.db;
  const { data: run, error } = await db
    .from('family_automation_runs')
    .select('*')
    .eq('id', runId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) {
    console.error('[ai/runs] failed to read the run detail', error);
    return fail(describeDbError(error, 'Bubaly could not open that run.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!run) return ok(null);

  const [{ data: plan, error: planError }, { data: steps, error: stepsError }, { data: events, error: eventsError }] = await Promise.all([
    run.plan_id
      ? db.from('ai_plans').select('*').eq('id', run.plan_id).eq('family_id', scope.familyId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    run.plan_id
      ? db.from('ai_plan_steps').select('*').eq('plan_id', run.plan_id).eq('family_id', scope.familyId).order('sequence', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    db.from('ai_run_events').select('*').eq('run_id', runId).eq('family_id', scope.familyId)
      .order('created_at', { ascending: true }).limit(opts?.eventLimit ?? 200),
  ]);

  // A run header without its steps would render as an empty, finished-looking
  // run, so these reads fail closed rather than degrading.
  const readError = planError ?? stepsError ?? eventsError;
  if (readError) {
    console.error('[ai/runs] failed to read the run detail parts', readError);
    return fail(describeDbError(readError, 'Bubaly could not open that run.'), { code: SERVICE_CODES.db, retryable: true });
  }

  return ok({
    run: run as RunRow,
    plan: (plan as PlanRow | null) ?? null,
    steps: (steps ?? []) as StepRow[],
    events: (events ?? []) as RunEventRow[],
  });
}

// ─── Actor re-check ─────────────────────────────────────────────────────────

export type RunActor = {
  memberId: string | null;
  userId: string | null;
  role: Database['public']['Tables']['family_members']['Row']['role'] | null;
  timezone: string;
};

/**
 * Re-read who a run is acting for, at claim time.
 *
 * A run can sit in the queue for hours across several invocations. If the
 * member who asked for it has been deactivated or demoted in the meantime,
 * finishing the work with their original authority would be exactly the
 * privilege-escalation hole the trust engine exists to close — so the executor
 * calls this on every continuation and blocks the run when the answer changed.
 */
export async function loadRunActor(
  db: SupabaseClient<Database>,
  familyId: string,
  memberId: string | null,
): Promise<ServiceResult<RunActor>> {
  const { data: family, error: familyError } = await db
    .from('families')
    .select('id, timezone')
    .eq('id', familyId)
    .maybeSingle();
  if (familyError) {
    console.error('[ai/runs] failed to read the family for a run', familyError);
    return fail(describeDbError(familyError, 'Bubaly could not read that family.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!family) return fail('That family no longer exists.', { code: SERVICE_CODES.notFound });

  const timezone = family.timezone || 'UTC';
  if (!memberId) return ok({ memberId: null, userId: null, role: null, timezone });

  const { data: member, error: memberError } = await db
    .from('family_members')
    .select('id, user_id, role, is_active, family_id')
    .eq('id', memberId)
    .eq('family_id', familyId)
    .maybeSingle();
  if (memberError) {
    console.error('[ai/runs] failed to re-read the run actor', memberError);
    return fail(describeDbError(memberError, 'Bubaly could not confirm who this run is for.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!member || !member.is_active) {
    return fail('The person who asked for this is no longer an active member of the family.', { code: SERVICE_CODES.denied });
  }
  return ok({ memberId: member.id, userId: member.user_id, role: member.role, timezone });
}
