// lib/ai/planner/index.ts — from a request to a persisted, runnable plan.
//
// `planRequest` is the one call between "a person asked for something" and
// "a run exists". It takes the intent the classifier chose and the context
// the builder assembled, and it:
//
//   1. loads the household's trust inputs ONCE (`loadTrustInputs`) so every
//      step's approval decision is a pure dry run over the same data — never
//      `evaluateTrust`, which writes an audit row per call (§4.6);
//   2. builds the prompt: the versioned rules, the intent's tool catalogue,
//      the workflow template's skeleton with the dates already resolved in the
//      family's zone, the context text, the request, and any answers the
//      person already gave;
//   3. asks the `plan` model for a `PlanSchema` reply through `structured()`
//      (strict json_schema, one schema-repair round), then validates it with
//      `validatePlan` — and grants ONE more round when the validator found
//      something the executor could not run (an unknown tool, a cycle, no
//      runnable step);
//   4. turns the result into exactly one outcome: a persisted plan + run
//      (`savePlan`, `createRun`, a `planned` timeline event), a recommendation
//      row when the household has asked Bubaly to recommend only (§11 level
//      1), a clarification persisted on the request (§36), or a plain answer.
//
// It does NOT start the run. The intake route does that with `kickRun` after
// it has replied, so the response never waits on execution (§4.3).
//
// Every ledger write goes through `lib/ai/runs/store.ts`, which uses the
// service client and filters `family_id`; the recommendation insert below
// follows the same rule. Nothing here throws for an expected failure.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiStepType, Database, Json } from '@/lib/database.types';
import { buildContext, type ContextBundle, type IntentKey } from '@/lib/ai/context/builder';
import type { AIMessage, AIProvider } from '@/lib/ai/provider';
import { resolveProviderForTask } from '@/lib/ai/routing';
import { appendEvent, createRun, ledgerClient, savePlan, updateRequest, updateRequestWhereStatus, updateRun, type PlanStepInput, type RequestRow, type RunRow, type StepRow } from '@/lib/ai/runs/store';
import { legacyStatusFor, TERMINAL_STEP_STATES } from '@/lib/ai/runs/states';
import { structured } from '@/lib/ai/structured';
import { listTools } from '@/lib/ai/tools/registry';
import { scopeNow } from '@/lib/services/scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { loadTrustInputs, roleOf } from '@/lib/trust/server';
import { getAISettings } from '@/lib/services/ai-settings';
import type { AutonomyBehavior, TrustRole } from '@/lib/trust/engine';
import { buildPlannerSystemPrompt, buildPlannerUserMessage, buildRepairMessage, PLANNER_PROMPT_VERSION, toolsForIntent } from './prompts';
import { PLAN_SCHEMA_NAME, PlanSchema, type Plan } from './schema';
import { instantiateTemplate, templateContextFrom, templateFor, templateSteps, type MoveContext, type TemplateContext, type WorkflowTemplate } from './templates/index';
import { behaviorFor, catalogueNames, dominantBehavior, validatePlan, type PlanIssue, type ValidatedStep, type ValidationInputs, type ValidationResult } from './validate';

export { PLANNER_PROMPT_VERSION } from './prompts';
export { PlanSchema, type Plan, type PlanStep } from './schema';
export type { ValidatedStep, PlanIssue } from './validate';

export type PlanOutcome =
  | { kind: 'plan'; planId: string; runId: string; stepCount: number; riskLevel: 'low' | 'medium' | 'high'; requiresApproval: boolean; summary: string }
  | { kind: 'recommendation'; recommendationId: string; summary: string }
  | { kind: 'clarification'; question: string; requestId: string }
  | { kind: 'answer'; text: string; card?: unknown };

export type PlanRequestInput = {
  requestId: string;
  requestText: string;
  intent: IntentKey;
  context: ContextBundle;
  conversationId?: string | null;
  /** Answers to earlier clarifications, keyed by the question asked. */
  answers?: Record<string, string> | null;
  /** Entities the classifier read from the request (day, person, trade…); optional. */
  entities?: Record<string, string> | null;
  pageContext?: { module?: string; entityIds?: string[] } | null;
  /**
   * §30 run-level dedupe key for the run this plan creates, derived by the
   * intake from the caller's client request id. A retry that reaches this far
   * re-finds the run instead of starting a second one over the same plan.
   */
  runIdempotencyKey?: string | null;
};

export type PlanRequestOptions = {
  /** Injected in tests and by the executor, which already holds a provider. */
  provider?: AIProvider;
  /** The ledger client, when the caller already holds the service client. */
  db?: SupabaseClient<Database>;
  now?: Date;
};

/** A plan is long; 4k output tokens covers thirty steps with full inputs. */
export const PLANNER_MAX_TOKENS = 4000;

/**
 * The role the executor will evaluate the run under (`lib/ai/tools/execute.ts
 * trustRoleFor`): a system actor is treated as the least-privileged role that
 * can act unattended. Copied rather than imported because that helper is
 * private to the executor, and the two must agree.
 */
export function plannerTrustRole(role: ServiceScope['role']): TrustRole {
  return role === 'system' ? 'adult' : roleOf(role);
}

type PeopleSlice = { members?: { id: string; canManage?: boolean }[] } | undefined;
type TravelSlice = { trips?: { id: string; title: string; startDate: string | null; daysUntil: number | null }[] } | undefined;
type MovingSlice = {
  move?: { id: string; title: string; moveDate: string; hasKids: boolean; hasPets: boolean; templateKeys?: string[] } | null;
  subscriptions?: MoveContext['subscriptions'];
  bills?: MoveContext['bills'];
  schoolClasses?: MoveContext['schoolClasses'];
  pets?: MoveContext['pets'];
} | undefined;

/** The move context from the `moving` slice — only loaded for plan_move, so every other intent sees null. */
function moveContextFrom(moving: MovingSlice): MoveContext | null {
  if (!moving) return null;
  return {
    move: moving.move ? {
      id: moving.move.id, title: moving.move.title, moveDate: moving.move.moveDate, hasKids: moving.move.hasKids, hasPets: moving.move.hasPets,
      templateKeys: moving.move.templateKeys ?? [],
    } : null,
    subscriptions: moving.subscriptions ?? [], bills: moving.bills ?? [], schoolClasses: moving.schoolClasses ?? [], pets: moving.pets ?? [],
  };
}

/** The template context for a request, from the bundle the builder already resolved in the family's zone. */
function templateContextFor(input: PlanRequestInput, scope: ServiceScope, now: Date): TemplateContext {
  const people = input.context.slices.people as PeopleSlice;
  const travel = input.context.slices.travel as TravelSlice;
  const moving = input.context.slices.moving as MovingSlice;
  return templateContextFrom({
    tz: input.context.header.tz,
    nowIso: now.toISOString(),
    todayKey: input.context.header.todayKey,
    requestText: input.requestText,
    entities: input.entities ?? null,
    viewerName: input.context.header.viewerName,
    viewerMemberId: scope.memberId,
    managerIds: (people?.members ?? []).filter((m) => m.canManage).map((m) => m.id),
    trips: (travel?.trips ?? []).map((t) => ({ id: t.id, title: t.title, startDate: t.startDate, daysUntil: t.daysUntil })),
    move: moveContextFrom(moving),
  });
}

/** `PlanStepInput` rows for `savePlan`, in the validator's order (reads first, then what depends on them). */
function toStoreSteps(steps: ValidatedStep[]): PlanStepInput[] {
  return steps.map((step) => ({
    key: step.key,
    stepType: step.stepType as AiStepType,
    toolName: step.toolName,
    description: step.description,
    input: step.input,
    dependsOn: step.dependsOn,
    condition: step.condition,
    approvalRequired: step.approvalRequired,
    riskLevel: step.riskLevel,
  }));
}

type ModelPlan = { plan: Plan; validation: ValidationResult | null };

/**
 * The model round trip plus the validator's own repair round. Returns the
 * last plan the model produced and its validation (null when the plan had no
 * steps and needs none — a clarification or an answer).
 */
async function askForPlan(
  provider: AIProvider,
  system: string,
  user: string,
  inputs: ValidationInputs,
  meter: { db: SupabaseClient<Database>; familyId: string },
  requestId: string,
): Promise<ServiceResult<ModelPlan>> {
  const messages: AIMessage[] = [{ role: 'user', content: user }];
  let last: ModelPlan | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await structured({
      schema: PlanSchema,
      schemaName: PLAN_SCHEMA_NAME,
      system,
      messages,
      task: 'plan',
      provider,
      meter,
      requestId,
      maxTokens: PLANNER_MAX_TOKENS,
    });
    if (!reply.ok) {
      console.error('[planner] the model could not produce a plan', { requestId, code: reply.code, error: reply.error });
      return fail(reply.error, { code: reply.code, retryable: reply.code === 'network' || reply.code === 'rate_limit' });
    }
    const plan = reply.data;

    // A question or a plain answer is a complete reply; there is nothing to validate.
    if (plan.steps.length === 0 && (plan.clarification || plan.answer)) return ok({ plan, validation: null });

    const validation = validatePlan(plan, inputs);
    last = { plan, validation };
    if (validation.ok) return ok(last);
    if (validation.code === 'empty' && validation.issues.some((i) => i.code === 'recommend_only')) return ok(last);

    if (attempt === 0) {
      // ONE repair round (§5). The validator's issues are precise enough for
      // the model to fix; a second failure means it cannot, and asking again
      // only costs the family another wait.
      messages.push({ role: 'assistant', content: JSON.stringify(plan) });
      messages.push({ role: 'user', content: buildRepairMessage(validation.issues.map((i) => i.message)) });
      continue;
    }
  }

  const issues = last?.validation && !last.validation.ok ? last.validation.issues : [];
  console.error('[planner] the plan could not be made runnable after one repair round', { requestId, issues });
  return fail(last?.validation && !last.validation.ok ? last.validation.error : 'Bubaly could not work out a plan for that.', { code: SERVICE_CODES.invalidInput });
}

/**
 * Plan one request. The scope is the requester's (their RLS client and role);
 * the ledger writes use the service client through the store.
 */
export async function planRequest(
  scope: ServiceScope,
  input: PlanRequestInput,
  opts: PlanRequestOptions = {},
): Promise<ServiceResult<PlanOutcome>> {
  const now = opts.now ?? scopeNow(scope);
  const ledger = ledgerClient(scope, opts.db ? { db: opts.db } : undefined);
  const { requestId, intent } = input;

  const marked = await updateRequest(scope, requestId, { status: 'planning', interpreted_intent: intent, started_at: now.toISOString() }, { db: ledger });
  if (!marked.ok) {
    // Bookkeeping, not the plan: the request row is what the family watches,
    // so a failure here is loud but does not stop the planning itself.
    console.error('[planner] could not mark the request as planning', { requestId, error: marked.error });
  }

  let trust: Awaited<ReturnType<typeof loadTrustInputs>>;
  try {
    trust = await loadTrustInputs(scope.db, scope.familyId);
  } catch (error) {
    console.error('[planner] trust inputs could not be loaded; nothing was planned', error);
    return fail(describeDbError(error, 'Bubaly could not check what it is allowed to do, so it did not plan anything.'), { code: SERVICE_CODES.db, retryable: true });
  }
  // The intent's catalogue is what the prompt offers AND what the validator
  // accepts: a step naming a real tool from another intent's catalogue is
  // dropped (`off_catalogue`), so the narrowing in `toolsForIntent` is a
  // boundary, not a suggestion.
  const tools = toolsForIntent(intent, listTools());
  // The family's own dials (0257) alongside their trust policies: a category
  // set to "Recommend only" in Settings → Bubaly AI has to shape the plan, not
  // just the execution of it.
  const settings = await getAISettings(scope);
  const inputs: ValidationInputs = {
    policies: trust.policies,
    grants: trust.grants,
    delegations: trust.delegations,
    emergencyDomains: trust.emergencyDomains,
    settings,
    role: plannerTrustRole(scope.role),
    now,
    tz: input.context.header.tz,
    allowedTools: catalogueNames(tools),
  };

  const template = templateFor(intent);
  const ctx = templateContextFor(input, scope, now);
  const skeleton = template ? instantiateTemplate(template, ctx) : null;
  const behaviorHint = dominantBehavior(
    tools.filter((t) => !t.readOnly).map((t) => behaviorFor(inputs, t.domain)),
  );

  const system = buildPlannerSystemPrompt({ intent, template, tools, behavior: behaviorHint, viewerRole: scope.role });
  const user = buildPlannerUserMessage({
    requestText: input.requestText,
    contextText: input.context.text,
    skeleton,
    skeletonHints: (template ? templateSteps(template, ctx) : []).filter((s) => s.modelFills).map((s) => ({ key: s.key, hint: s.modelFills as string })),
    answers: input.answers ?? null,
    pageContext: input.pageContext ?? null,
  });

  let provider: AIProvider;
  try {
    provider = opts.provider ?? (await resolveProviderForTask('plan'));
  } catch (error) {
    console.error('[planner] no planning model available', error);
    return fail('The AI engine is not available right now.', { code: 'unconfigured', retryable: true });
  }

  const asked = await askForPlan(provider, system, user, inputs, { db: ledger, familyId: scope.familyId }, requestId);
  if (!asked.ok) {
    await updateRequest(scope, requestId, { status: 'failed', error: asked.error, completed_at: now.toISOString() }, { db: ledger });
    return asked;
  }
  const { plan, validation } = asked.data;

  // ── Clarification (§36): persisted on the request, run not created ─────
  if (validation === null && plan.clarification) {
    return recordClarification(scope, ledger, requestId, plan.clarification.question, plan.clarification.reason, now);
  }
  // ── Pure answer: nothing to execute ────────────────────────────────────
  if (validation === null) {
    const text = (plan.answer ?? '').trim();
    await updateRequest(scope, requestId, { status: 'completed', completed_at: now.toISOString(), error: null }, { db: ledger });
    return ok({ kind: 'answer', text });
  }
  if (plan.clarification) {
    // The model both planned and asked. The question wins: it said a missing
    // fact would change the outcome, and running the guess would be worse
    // than one short question.
    return recordClarification(scope, ledger, requestId, plan.clarification.question, plan.clarification.reason, now);
  }

  // ── Recommend only (§11 level 1): a recommendation row, no run ─────────
  const recommendOnly = validation.ok ? validation.recommendOnly : [];
  const hasActs = validation.ok && validation.steps.some((s) => s.stepType === 'act');
  if (!validation.ok || (recommendOnly.length > 0 && !hasActs)) {
    if (!validation.ok && validation.code !== 'empty') {
      await updateRequest(scope, requestId, { status: 'failed', error: validation.error, completed_at: now.toISOString() }, { db: ledger });
      return fail(validation.error, { code: SERVICE_CODES.invalidInput });
    }
    return recordRecommendation(scope, ledger, {
      requestId, intent, template, plan, recommendOnly, provider, now,
      issues: validation.ok ? validation.issues : validation.issues,
      behavior: validation.ok ? validation.behavior : 'recommend',
    });
  }

  // ── A runnable plan ─────────────────────────────────────────────────────
  const saved = await savePlan(scope, requestId, {
    objective: validation.objective,
    reasoningSummary: validation.reasoningSummary,
    riskLevel: validation.riskLevel,
    requiresApproval: validation.requiresApproval,
    plannerModel: provider.model,
    plannerPromptVersion: PLANNER_PROMPT_VERSION,
    steps: toStoreSteps(validation.steps),
  }, { db: ledger });
  if (!saved.ok) {
    await updateRequest(scope, requestId, { status: 'failed', error: saved.error, completed_at: now.toISOString() }, { db: ledger });
    return saved;
  }

  const run = await createRun(scope, {
    requestId,
    planId: saved.data.planId,
    runType: 'concierge',
    summary: validation.objective,
    state: 'ready',
    runAfter: now.toISOString(),
    idempotencyKey: input.runIdempotencyKey ?? null,
  }, { db: ledger });
  if (!run.ok) {
    await updateRequest(scope, requestId, { status: 'failed', error: run.error, completed_at: now.toISOString() }, { db: ledger });
    return run;
  }

  const stepCount = validation.steps.length;
  const heldForApproval = validation.steps.filter((s) => s.approvalRequired).length;
  await appendEvent(scope, run.data.id, {
    eventType: 'planned',
    requestId,
    message: heldForApproval
      ? `Planned ${stepCount} step${stepCount === 1 ? '' : 's'}; ${heldForApproval} will wait for a yes.`
      : `Planned ${stepCount} step${stepCount === 1 ? '' : 's'}.`,
    payload: {
      plan_id: saved.data.planId,
      version: saved.data.version,
      step_count: stepCount,
      approval_steps: heldForApproval,
      risk_level: validation.riskLevel,
      prompt_version: PLANNER_PROMPT_VERSION,
      model: provider.model,
      // Codes only: the messages can quote model output, and this table is
      // readable by the whole family.
      adjustments: validation.issues.map((i) => i.code),
      template: template?.intent ?? null,
      agent: template?.agent ?? null,
    } as Json,
  }, { db: ledger });
  // Compare-and-set, not a plain update: the intake gives up on a slow
  // planner at its deadline, marks the request failed and tells the person
  // to try again. If that happened while the model was still thinking, the
  // request is no longer `planning` and the plan we just saved must never
  // run — otherwise the retry and this late plan would both execute (twice
  // the dinners, twice the reminders). Cancel the run so no claim can take it.
  const claimed = await updateRequestWhereStatus(scope, requestId, 'planning', { status: 'ready', error: null }, { db: ledger });
  if (!claimed.ok || !claimed.data) {
    await updateRun(scope, run.data.id, { state: 'cancelled', status: legacyStatusFor('cancelled'), completed_at: now.toISOString() }, { db: ledger });
    await appendEvent(scope, run.data.id, {
      eventType: 'cancelled',
      requestId,
      message: 'Planning finished after the request had been abandoned, so nothing will run.',
    }, { db: ledger });
    return fail('That request was abandoned before planning finished.', { code: SERVICE_CODES.invalidInput });
  }

  return ok({
    kind: 'plan',
    planId: saved.data.planId,
    runId: run.data.id,
    stepCount,
    riskLevel: validation.riskLevel,
    requiresApproval: validation.requiresApproval,
    summary: validation.reasoningSummary || validation.objective,
  });
}

// ── Outcomes that create no run ─────────────────────────────────────────────

type ClarificationEntry = { question: string; reason: string | null; asked_at: string; answer: string | null; answered_at: string | null };

/**
 * Append the question to `ai_requests.clarifications` and park the request at
 * `awaiting_context`. The run controls' `answer` route feeds the answer back
 * into `planRequest` as `answers`, so the same request continues instead of
 * a new one starting (§45 Persistence).
 */
async function recordClarification(
  scope: ServiceScope,
  ledger: SupabaseClient<Database>,
  requestId: string,
  question: string,
  reason: string,
  now: Date,
): Promise<ServiceResult<PlanOutcome>> {
  const { data: row, error: readError } = await ledger
    .from('ai_requests')
    .select('clarifications')
    .eq('id', requestId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (readError) {
    console.error('[planner] could not read the request to record a clarification', readError);
    return fail(describeDbError(readError, 'Bubaly had a question but could not save it.'), { code: SERVICE_CODES.db, retryable: true });
  }
  const existing = Array.isArray(row?.clarifications) ? (row.clarifications as unknown as ClarificationEntry[]) : [];
  const entry: ClarificationEntry = { question: question.trim(), reason: reason.trim() || null, asked_at: now.toISOString(), answer: null, answered_at: null };
  const updated = await updateRequest(scope, requestId, {
    status: 'awaiting_context',
    clarifications: [...existing, entry] as unknown as Json,
    error: null,
  }, { db: ledger });
  if (!updated.ok) return updated;
  return ok({ kind: 'clarification', question: entry.question, requestId });
}

type RecommendationInput = {
  requestId: string;
  intent: IntentKey;
  template: WorkflowTemplate | null;
  plan: Plan;
  recommendOnly: ValidatedStep[];
  provider: AIProvider;
  now: Date;
  issues: PlanIssue[];
  behavior: AutonomyBehavior | null;
};

/**
 * §11 level 1. The household has said "recommend, don't act", so the plan
 * becomes a `family_ai_recommendations` row the Command Center shows under
 * Needs-you: the objective as the title, the reasoning summary plus the
 * actions Bubaly would have taken as the body, the step list in `metadata`
 * so accepting it later can become a run.
 */
async function recordRecommendation(
  scope: ServiceScope,
  ledger: SupabaseClient<Database>,
  input: RecommendationInput,
): Promise<ServiceResult<PlanOutcome>> {
  const actions = (input.recommendOnly.length ? input.recommendOnly : []).map((s) => s.description);
  const proposed = input.plan.steps.filter((s) => s.step_type === 'act').map((s) => s.description);
  const lines = actions.length ? actions : proposed;
  const body = [
    input.plan.reasoning_summary.trim(),
    lines.length ? `What Bubaly would do:\n${lines.map((l) => `• ${l}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const { data, error } = await ledger
    .from('family_ai_recommendations')
    .insert({
      family_id: scope.familyId,
      member_id: scope.memberId,
      category: input.template?.agent ?? input.intent,
      title: input.plan.objective.trim().slice(0, 200) || 'A recommendation from Bubaly',
      body,
      priority: input.plan.risk_level === 'high' ? 'high' : 'medium',
      cta_href: '/dashboard/concierge/runs',
      source: 'concierge',
      status: 'pending',
      metadata: {
        request_id: input.requestId,
        intent: input.intent,
        behavior: input.behavior,
        planner_model: input.provider.model,
        planner_prompt_version: PLANNER_PROMPT_VERSION,
        steps: input.plan.steps.map((s) => ({ key: s.key, step_type: s.step_type, tool_name: s.tool_name, description: s.description, input: s.input })),
        adjustments: input.issues.map((i) => i.code),
      } as unknown as Json,
      created_by: scope.userId,
    })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[planner] could not save the recommendation', error);
    await updateRequest(scope, input.requestId, { status: 'failed', error: 'Could not save the recommendation.', completed_at: input.now.toISOString() }, { db: ledger });
    return fail(describeDbError(error, 'Bubaly worked out what to suggest but could not save it.'), { code: SERVICE_CODES.db, retryable: true });
  }

  await updateRequest(scope, input.requestId, { status: 'completed', completed_at: input.now.toISOString(), error: null }, { db: ledger });
  return ok({ kind: 'recommendation', recommendationId: data.id, summary: input.plan.reasoning_summary.trim() || input.plan.objective });
}

// ── Re-planning (the executor's `replan` port) ─────────────────────────────

type RunLike = Pick<RunRow, 'id' | 'family_id' | 'plan_id' | 'request_id' | 'requested_by_member_id'>;
type StepLike = Pick<StepRow, 'id' | 'step_type' | 'tool_name' | 'description' | 'input_json' | 'dependency_ids' | 'condition' | 'status' | 'approval_required' | 'approval_id' | 'risk_level' | 'result_json' | 'error'>;

/** A carried step's line in the re-plan prompt: what it was and how it ended. */
function describeOutcome(step: StepLike): string {
  const label = step.description ?? step.tool_name ?? step.step_type;
  const summary = step.result_json && typeof step.result_json === 'object' && !Array.isArray(step.result_json)
    ? String((step.result_json as Record<string, unknown>).summary ?? '')
    : '';
  switch (step.status) {
    case 'completed': return `- ${label}: ${summary || 'done'}`;
    case 'skipped': return `- ${label}: skipped${summary ? ` (${summary})` : ''}`;
    case 'partially_completed': return `- ${label}: done, but could not be confirmed${summary ? ` (${summary})` : ''}`;
    case 'failed': return `- ${label}: FAILED${step.error ? ` (${step.error})` : ''}`;
    case 'cancelled': return `- ${label}: DECLINED by a person${step.error ? ` (${step.error})` : ''}; do not plan it again`;
    default: return `- ${label}: ${step.status}`;
  }
}

/**
 * Plan the rest of a run with what it has learned so far — the implementation
 * behind a `replan` step. `replanPortFor` (./replan-port.ts) binds a ledger
 * client to it so it is exactly `ExecutorPort['replan']`; lib/ai/runs/
 * continue.ts and the cron hand that to `runGraph`, and a port built without
 * it blocks a replan step honestly instead of pretending.
 *
 * Version N+1 carries every step that already RAN or was DECIDED — the
 * terminal states (completed, skipped, partially_completed, failed,
 * cancelled) — with its status, result and error, the way `editStepInput`
 * carries finished work: nothing done is repeated, and nothing that went
 * wrong disappears from the record the run reports on. The replan step itself
 * is carried as completed, which is how the executor counts a run's re-plans
 * (`MAX_REPLANS_PER_RUN`) without a second query. Steps that never ran —
 * blocked behind a failure, or still queued — are what the new plan replaces.
 */
export async function replanRun(
  scope: ServiceScope,
  run: RunLike,
  step: StepLike,
  steps: StepLike[],
  opts: PlanRequestOptions = {},
): Promise<ServiceResult<{ planId: string }>> {
  if (!run.request_id) return fail('This run was not created from a request, so it cannot be re-planned.', { code: SERVICE_CODES.invalidInput });
  const now = opts.now ?? scopeNow(scope);
  const ledger = ledgerClient(scope, opts.db ? { db: opts.db } : undefined);

  const { data: request, error: requestError } = await ledger
    .from('ai_requests')
    .select('*')
    .eq('id', run.request_id)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (requestError || !request) {
    console.error('[planner] could not read the request for a re-plan', requestError);
    return fail(describeDbError(requestError, 'Bubaly could not read the original request.'), { code: SERVICE_CODES.db, retryable: true });
  }
  const row = request as RequestRow;
  const intent = (row.interpreted_intent ?? 'other') as IntentKey;

  const context = await buildContext(scope, { intent, requestId: row.id });
  if (!context.ok) return context;

  let trust: Awaited<ReturnType<typeof loadTrustInputs>>;
  try {
    trust = await loadTrustInputs(scope.db, scope.familyId);
  } catch (error) {
    console.error('[planner] trust inputs could not be loaded for a re-plan', error);
    return fail(describeDbError(error, 'Bubaly could not check what it is allowed to do.'), { code: SERVICE_CODES.db, retryable: true });
  }
  const tools = toolsForIntent(intent, listTools());
  const inputs: ValidationInputs = {
    policies: trust.policies, grants: trust.grants, delegations: trust.delegations, emergencyDomains: trust.emergencyDomains,
    settings: await getAISettings(scope),
    role: plannerTrustRole(scope.role), now, tz: context.data.header.tz, allowedTools: catalogueNames(tools),
  };

  const settled = steps.filter((s) => s.id !== step.id && TERMINAL_STEP_STATES.includes(s.status));
  const stepPrompt = typeof (step.input_json as Record<string, unknown> | null)?.prompt === 'string'
    ? String((step.input_json as Record<string, unknown>).prompt)
    : (step.description ?? 'Plan the rest of this request.');

  const system = buildPlannerSystemPrompt({
    intent, template: null, tools, viewerRole: scope.role,
    behavior: dominantBehavior(tools.filter((t) => !t.readOnly).map((t) => behaviorFor(inputs, t.domain))),
  });
  const user = [
    buildPlannerUserMessage({ requestText: row.request_text, contextText: context.data.text, skeleton: null, skeletonHints: [] }),
    '',
    'This request is already under way. What has happened so far:',
    ...(settled.length ? settled.map(describeOutcome) : ['- nothing yet']),
    '',
    `Now: ${stepPrompt}`,
    'Plan ONLY the remaining work: do not repeat anything marked done, and do not plan again anything a person declined.',
  ].join('\n');

  let provider: AIProvider;
  try {
    provider = opts.provider ?? (await resolveProviderForTask('plan'));
  } catch (error) {
    console.error('[planner] no planning model available for a re-plan', error);
    return fail('The AI engine is not available right now.', { code: 'unconfigured', retryable: true });
  }
  const asked = await askForPlan(provider, system, user, inputs, { db: ledger, familyId: scope.familyId }, row.id);
  if (!asked.ok) return asked;
  const { validation } = asked.data;
  if (!validation || !validation.ok) {
    return fail(validation && !validation.ok ? validation.error : 'Bubaly had nothing more to plan for this request.', { code: SERVICE_CODES.invalidInput });
  }

  // Carry settled work forward by its id (keys are planner-local, so an id is
  // the one handle that cannot collide with the new steps' keys), then the
  // replan step itself as the completed decision point it is.
  const carriedIds = new Set(settled.map((s) => s.id));
  carriedIds.add(step.id);
  const carried: PlanStepInput[] = settled.map((s) => ({
    key: s.id,
    stepType: s.step_type,
    toolName: s.tool_name,
    description: s.description,
    input: s.input_json,
    dependsOn: s.dependency_ids.filter((id) => carriedIds.has(id)),
    condition: s.condition,
    approvalRequired: s.approval_required,
    riskLevel: s.risk_level,
    status: s.status,
    resultJson: s.result_json,
    approvalId: s.approval_id,
    error: s.error,
  }));
  carried.push({
    key: step.id,
    stepType: 'replan',
    toolName: null,
    description: step.description,
    input: step.input_json,
    dependsOn: step.dependency_ids.filter((id) => carriedIds.has(id)),
    condition: step.condition,
    approvalRequired: false,
    riskLevel: step.risk_level,
    status: 'completed',
    resultJson: { summary: 'Re-planned the rest of this run.' },
    approvalId: null,
    error: null,
  });
  const fresh = toStoreSteps(validation.steps);

  const saved = await savePlan(scope, row.id, {
    objective: validation.objective,
    reasoningSummary: validation.reasoningSummary,
    riskLevel: validation.riskLevel,
    requiresApproval: validation.requiresApproval,
    plannerModel: provider.model,
    plannerPromptVersion: PLANNER_PROMPT_VERSION,
    steps: [...carried, ...fresh],
  }, { db: ledger });
  if (!saved.ok) return saved;
  return ok({ planId: saved.data.planId });
}
