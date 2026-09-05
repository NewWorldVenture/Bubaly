// lib/ai/runs/intake.ts — one request in, one outcome out (§1, §4.3, §10).
//
// The pipeline every Ask Bubaly entry shares, whatever transport it came in on:
//
//   createRequest → classifyIntent → buildContext → planRequest → outcome
//
// The route and the server action are thin wrappers over `submitRequest`, so
// the web bar, the command bar, the mobile app and a test all file a request
// through exactly the same steps and persist exactly the same rows.
//
// WHY the response is decided BEFORE execution: the planner's job ends when a
// plan is persisted; the run's job starts afterwards and can take minutes and
// several invocations. The caller gets the run id and navigates to a page that
// subscribes to progress, and `kick` hands the first execution slice to
// `after()` (see `continue.ts`). A person never waits on a tool call.
//
// WHY clarifications create a run: §45 says a request survives a refresh. A
// question Bubaly asks is parked as a run in `awaiting_context` so it shows
// under "Needs your attention", has a page, and can be answered later from
// any device. `answerClarification` re-plans the SAME request — the answer is
// appended to `ai_requests.clarifications` and the plan lands as the next
// version — and continues the SAME run, so the page the person is on is the
// page the work happens on.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { buildContext } from '@/lib/ai/context/builder';
import { classifyIntent, isIntentKey, type IntentKey } from '@/lib/ai/context/intents';
import { planRequest, type PlanOutcome } from '@/lib/ai/planner';
import { runPagePath, type AIRequestContext, type AIRequestResponse } from '@/lib/ai/chat-request';
import { isManager } from '@/lib/constants/roles';
import { describeDbError } from '@/lib/supabase/errors';
import { makeKey } from '@/lib/services/idempotency';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { cancelRun, pauseRun, rerunStep, resumeRun } from './controls';
import { kickRun } from './continue';
import { legacyStatusFor } from './states';
import {
  appendEvent, createRequest, createRun, ledgerClient, loadRun, updateRequest, updateRun, updateRunWhereState, type RequestRow,
} from './store';

type DB = SupabaseClient<Database>;

/** How long the planner may take before the caller is told to look at the run page later. */
export const DEFAULT_PLANNER_BUDGET_MS = 20_000;
/** Vercel's limit for the request route (`maxDuration = 300`); the execution slice is carved out of what is left. */
export const REQUEST_ROUTE_MAX_MS = 300_000;
/** Kept back so the slice always ends before the platform ends the invocation. */
const EXECUTION_RESERVE_MS = 20_000;
const MIN_EXECUTION_SLICE_MS = 15_000;
const MAX_EXECUTION_SLICE_MS = 240_000;

export const INTAKE_CODES = {
  timeout: 'planner_timeout',
  planner: 'planner_failed',
  context: 'context_failed',
  /** A retry arrived under a key whose first submission is still being planned. */
  inProgress: 'request_in_progress',
} as const;

export type IntakeOptions = {
  /** Ledger client; the request route creates one per call so tests can hand in a fake. */
  db?: DB;
  plannerBudgetMs?: number;
  /** When the invocation started, so the execution slice fits in what is left of `maxDuration`. */
  startedAtMs?: number;
  /** Replaces `kickRun`; the route relies on `after()`, a server action or a test may not. */
  kick?: (runId: string, opts: { budgetMs: number }) => void;
  now?: Date;
};

export type IntakeResult = AIRequestResponse & {
  /** True when the answer was rebuilt from a request that already existed under the caller's key (nothing was planned). */
  replayed?: boolean;
};

/**
 * One entry of `ai_requests.clarifications`, in the shape the planner writes
 * (`{question, reason, asked_at, answer, answered_at}`). Kept as the raw
 * record plus the two fields this module reads, so an answer never drops a
 * field the planner added.
 */
type Clarification = Record<string, unknown> & { question: string; answer: string | null };

/** The execution budget for the slice that runs after the response, given how much of the invocation the planner used. */
export function executionBudgetMs(startedAtMs: number, nowMs = Date.now()): number {
  const remaining = REQUEST_ROUTE_MAX_MS - (nowMs - startedAtMs) - EXECUTION_RESERVE_MS;
  return Math.max(MIN_EXECUTION_SLICE_MS, Math.min(MAX_EXECUTION_SLICE_MS, remaining));
}

export type DeadlineResult<T> = { status: 'ok'; value: T } | { status: 'timeout' } | { status: 'threw'; error: unknown };

/** Race a promise against the planner budget. The loser is not awaited again by this caller. */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<DeadlineResult<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve({ status: 'ok', value }); },
      (error) => { clearTimeout(timer); resolve({ status: 'threw', error }); },
    );
  });
}

/** Normalise a deadline race over a `ServiceResult` into one `ServiceResult`. */
function settlePlanner<T>(planned: DeadlineResult<ServiceResult<T>>): ServiceResult<T> {
  if (planned.status === 'ok') return planned.value;
  if (planned.status === 'timeout') {
    return fail('Bubaly is taking longer than expected on that one. Try again in a moment.', { code: INTAKE_CODES.timeout, retryable: true });
  }
  console.error('[ai/intake] planner threw', planned.error);
  return fail('Bubaly could not plan that request.', { code: INTAKE_CODES.planner, retryable: true });
}

function parseClarifications(raw: unknown): Clarification[] {
  if (!Array.isArray(raw)) return [];
  const out: Clarification[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.question !== 'string') continue;
    out.push({ ...rec, question: rec.question, answer: typeof rec.answer === 'string' && rec.answer.trim() ? rec.answer : null });
  }
  return out;
}

function answersFrom(clarifications: Clarification[], extra: Record<string, string> | null | undefined): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const c of clarifications) if (c.answer) answers[c.question] = c.answer;
  for (const [k, v] of Object.entries(extra ?? {})) answers[k] = v;
  return Object.keys(answers).length ? answers : null;
}

async function markRequestFailed(scope: ServiceScope, db: DB, requestId: string, error: string): Promise<void> {
  const result = await updateRequest(scope, requestId, { status: 'failed', error, completed_at: new Date().toISOString() }, { db });
  if (!result.ok) console.error('[ai/intake] could not mark the request failed', result.error);
}

/**
 * Link the exchange to the conversation it came from. The concierge message
 * carries `request_id` (0250) so the chat can render the run card in place.
 * Losing a message row is logged, never fatal: the request already exists.
 */
async function recordConversationTurn(
  scope: ServiceScope,
  db: DB,
  conversationId: string,
  requestId: string,
  turn: { role: 'user' | 'assistant'; content: string; card?: unknown },
): Promise<void> {
  const { error } = await db.from('ai_messages').insert({
    family_id: scope.familyId,
    conversation_id: conversationId,
    role: turn.role,
    content: turn.content,
    request_id: requestId,
    sender_member_id: turn.role === 'user' ? scope.memberId : null,
    structured_content: (turn.card ?? null) as Json | null,
  });
  if (error) console.error('[ai/intake] failed to record the conversation turn', error);
}

function runStatusCard(outcome: Extract<PlanOutcome, { kind: 'plan' | 'clarification' }>, runId: string): Record<string, unknown> {
  return outcome.kind === 'plan'
    ? { kind: 'run_status', title: outcome.summary, runId, planId: outcome.planId, stepCount: outcome.stepCount, riskLevel: outcome.riskLevel, requiresApproval: outcome.requiresApproval, state: 'ready' }
    : { kind: 'run_status', title: outcome.question, runId, state: 'awaiting_context' };
}

/**
 * File and plan one request. Resolves to the 202 body once a plan (or a
 * question, an answer or a recommendation) is persisted; execution starts
 * afterwards via `kick`.
 */
export async function submitRequest(
  scope: ServiceScope,
  input: { text: string; conversationId?: string | null; context?: AIRequestContext | null; answers?: Record<string, string> | null; clientRequestId?: string | null },
  opts: IntakeOptions = {},
): Promise<ServiceResult<IntakeResult>> {
  const text = input.text.trim();
  if (!text) return fail('Tell Bubaly what you need.', { code: SERVICE_CODES.invalidInput });
  const startedAt = opts.startedAtMs ?? Date.now();
  const db = ledgerClient(scope, { db: opts.db });
  const kick = opts.kick ?? kickRun;
  const conversationId = input.conversationId ?? null;

  if (conversationId) {
    // The client owns the conversation UUID, never its authorization boundary.
    const { data: conversation, error } = await scope.db
      .from('ai_conversations').select('id').eq('id', conversationId).eq('family_id', scope.familyId).eq('user_id', scope.userId ?? '').maybeSingle();
    if (error) {
      console.error('[ai/intake] conversation ownership read failed', error);
      return fail(describeDbError(error, 'Bubaly could not open that conversation.'), { code: SERVICE_CODES.db, retryable: true });
    }
    if (!conversation) return fail('Conversation not found.', { code: SERVICE_CODES.notFound });
  }

  // Through the caller's OWN client on purpose: 0250 gives members INSERT on
  // ai_requests with `requested_by = auth.uid()`, so RLS proves the requester.
  const clientRequestId = input.clientRequestId ?? null;
  const created = await createRequest(scope, { requestText: text, kind: 'concierge', conversationId, clientRequestId });
  if (!created.ok) return created;
  // A retried POST (a dropped connection, a double tap) lands here: the key
  // already names a request, so the answer is the one that request got —
  // never a second plan and a second run over the same words.
  if (created.data.existing) return replayRequest(scope, db, created.data.id);
  const requestId = created.data.id;
  const requestScope: ServiceScope = { ...scope, requestId };
  // The run row gets the same key, so even a retry that somehow reached the
  // planner would re-find this run instead of creating another (0250's index).
  const runIdempotencyKey = clientRequestId ? makeKey([scope.familyId, 'request', clientRequestId]) : null;

  const planning = await updateRequest(requestScope, requestId, { status: 'planning', started_at: new Date().toISOString() }, { db });
  if (!planning.ok) return planning;
  if (conversationId) await recordConversationTurn(requestScope, db, conversationId, requestId, { role: 'user', content: text });

  const pageContext = input.context?.module ? { module: input.context.module } : null;
  const classified = await classifyIntent(requestScope, text, { pageContext, meter: { db, familyId: scope.familyId }, now: opts.now });
  const intent: IntentKey = classified.intent;
  const intentSaved = await updateRequest(requestScope, requestId, {
    interpreted_intent: intent,
    intent_confidence: Math.max(0, Math.min(1, Number(classified.confidence.toFixed(3)))),
  }, { db });
  if (!intentSaved.ok) console.error('[ai/intake] could not persist the interpreted intent', intentSaved.error);

  const context = await buildContext(requestScope, { intent, requestId, pageContext: input.context ?? null });
  if (!context.ok) {
    await markRequestFailed(requestScope, db, requestId, context.error);
    return fail(context.error, { code: INTAKE_CODES.context, retryable: context.retryable });
  }

  const planned = settlePlanner(await withDeadline(
    planRequest(requestScope, {
      requestId, requestText: text, intent, context: context.data, conversationId,
      answers: input.answers ?? null, entities: classified.entities, pageContext: input.context ?? null, runIdempotencyKey,
    }),
    opts.plannerBudgetMs ?? DEFAULT_PLANNER_BUDGET_MS,
  ));
  if (!planned.ok) {
    await markRequestFailed(requestScope, db, requestId, planned.code === INTAKE_CODES.timeout ? INTAKE_CODES.timeout : planned.error);
    return fail(planned.error, { code: planned.code ?? INTAKE_CODES.planner, retryable: planned.retryable });
  }

  return finalizeOutcome(requestScope, db, { requestId, conversationId, outcome: planned.data, kick, startedAt });
}

/**
 * The response for a request that already exists under the caller's key,
 * rebuilt from the rows the first submission left behind: its latest run
 * (plan attached → 'plan'; parked → 'clarification'; closed without a plan →
 * 'answer') or, with no run, the request's own status. A key whose first
 * submission is still planning is reported as such rather than planned again.
 */
async function replayRequest(scope: ServiceScope, db: DB, requestId: string): Promise<ServiceResult<IntakeResult>> {
  const { data: request, error: requestError } = await db
    .from('ai_requests').select('id, status, error, requested_by').eq('id', requestId).eq('family_id', scope.familyId).maybeSingle();
  if (requestError) {
    console.error('[ai/intake] could not re-read a request for replay', requestError);
    return fail(describeDbError(requestError, 'Bubaly could not open that request.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!request) return fail('That request could not be found.', { code: SERVICE_CODES.notFound });
  // The key is unique per family, but a replay is only ever the requester's
  // own: another member reusing the same key gets a conflict, not a redirect
  // to somebody else's request.
  if (request.requested_by !== scope.userId) {
    return fail('That request id was already used by someone else in your family.', { code: SERVICE_CODES.invalidInput });
  }

  const { data: runs, error: runError } = await db
    .from('family_automation_runs').select('id, plan_id, state, summary')
    .eq('family_id', scope.familyId).eq('request_id', requestId)
    .order('created_at', { ascending: false }).limit(1);
  if (runError) {
    console.error('[ai/intake] could not read the run for a replayed request', runError);
    return fail(describeDbError(runError, 'Bubaly could not open that request.'), { code: SERVICE_CODES.db, retryable: true });
  }
  const run = runs?.[0] ?? null;
  if (run) {
    const summary = run.summary ?? '';
    const outcome: IntakeResult['outcome'] = run.plan_id ? 'plan' : run.state === 'awaiting_context' ? 'clarification' : 'answer';
    return ok({
      requestId, runId: run.id, planId: run.plan_id, outcome, summary, redirect: runPagePath(run.id),
      ...(outcome === 'clarification' ? { question: summary } : {}), replayed: true,
    });
  }
  switch (request.status) {
    case 'completed':
      // Answered or recommended inline; the text lives in the conversation, not on the request.
      return ok({ requestId, runId: null, planId: null, outcome: 'answer', summary: '', redirect: null, replayed: true });
    case 'failed':
      return fail(request.error || 'Bubaly could not plan that request.', { code: INTAKE_CODES.planner, retryable: true });
    default:
      return fail('Bubaly is still working on that request. Check back in a moment.', { code: INTAKE_CODES.inProgress, retryable: true });
  }
}

async function finalizeOutcome(
  scope: ServiceScope,
  db: DB,
  args: { requestId: string; conversationId: string | null; outcome: PlanOutcome; kick: NonNullable<IntakeOptions['kick']>; startedAt: number },
): Promise<ServiceResult<IntakeResult>> {
  const { requestId, conversationId, outcome, kick, startedAt } = args;

  switch (outcome.kind) {
    case 'plan': {
      if (conversationId) {
        await recordConversationTurn(scope, db, conversationId, requestId, { role: 'assistant', content: outcome.summary, card: runStatusCard(outcome, outcome.runId) });
      }
      kick(outcome.runId, { budgetMs: executionBudgetMs(startedAt) });
      return ok({ requestId, runId: outcome.runId, planId: outcome.planId, outcome: 'plan', summary: outcome.summary, redirect: runPagePath(outcome.runId) });
    }
    case 'recommendation': {
      // The planner closes the request when it files the recommendation.
      if (conversationId) {
        await recordConversationTurn(scope, db, conversationId, requestId, { role: 'assistant', content: outcome.summary, card: { kind: 'summary', title: outcome.summary, recommendationId: outcome.recommendationId } });
      }
      return ok({ requestId, runId: null, planId: null, outcome: 'recommendation', summary: outcome.summary, redirect: null });
    }
    case 'answer': {
      // The planner closes the request when it answers.
      if (conversationId) {
        await recordConversationTurn(scope, db, conversationId, requestId, { role: 'assistant', content: outcome.text, card: outcome.card ?? null });
      }
      return ok({ requestId, runId: null, planId: null, outcome: 'answer', summary: outcome.text, redirect: null });
    }
    case 'clarification': {
      const run = await createRun(scope, { requestId, runType: 'concierge', summary: outcome.question, state: 'awaiting_context' }, { db });
      if (!run.ok) return run;
      const parked = await parkForClarification(scope, db, { requestId, runId: run.data.id, question: outcome.question });
      if (!parked.ok) return parked;
      if (conversationId) {
        await recordConversationTurn(scope, db, conversationId, requestId, { role: 'assistant', content: outcome.question, card: runStatusCard(outcome, run.data.id) });
      }
      return ok({ requestId, runId: run.data.id, planId: null, outcome: 'clarification', summary: outcome.question, question: outcome.question, redirect: runPagePath(run.data.id) });
    }
    default:
      // The planner contract is exhaustive above; a new kind must be shown before it is shipped.
      console.error('[ai/intake] unknown planner outcome', outcome);
      return fail('Bubaly could not finish planning that request.', { code: INTAKE_CODES.planner });
  }
}

/**
 * Put the question on the run timeline. The planner has already appended it
 * to `ai_requests.clarifications` and parked the request at
 * `awaiting_context` (`recordClarification`); writing it again here would
 * show the family the same question twice.
 */
async function parkForClarification(
  scope: ServiceScope,
  db: DB,
  args: { requestId: string; runId: string; question: string },
): Promise<ServiceResult<null>> {
  await appendEvent(scope, args.runId, { eventType: 'clarification_asked', message: args.question, requestId: args.requestId }, { db });
  return ok(null);
}

// ─── Answering ──────────────────────────────────────────────────────────────

/**
 * Answer the question a run is waiting on and continue that run.
 *
 * The planner creates a fresh run for the new plan version; that run is
 * removed with a guarded DELETE (`state = 'ready' and lease_owner is null`) and
 * the plan is attached to the run the person is looking at. The guard is what
 * makes this safe against the cron: if `claim_ai_runs` leased the planner's
 * run first, the DELETE matches nothing and the work simply continues there —
 * the person is redirected, and nothing is ever executed twice.
 */
export async function answerClarification(
  scope: ServiceScope,
  runId: string,
  answer: string,
  opts: IntakeOptions = {},
): Promise<ServiceResult<IntakeResult>> {
  const reply = answer.trim();
  if (!reply) return fail('Type an answer for Bubaly.', { code: SERVICE_CODES.invalidInput });
  const startedAt = opts.startedAtMs ?? Date.now();
  const db = ledgerClient(scope, { db: opts.db });
  const kick = opts.kick ?? kickRun;

  const loaded = await loadRun(scope, runId, { db });
  if (!loaded.ok) return loaded;
  const run = loaded.data;
  if (!run) return fail('That run could not be found.', { code: SERVICE_CODES.notFound });
  const requester = !!scope.memberId && run.requested_by_member_id === scope.memberId;
  if (!isManager(scope.role) && !requester) return fail('Only a parent or adult in the family, or the person who asked, can answer that.', { code: SERVICE_CODES.denied });
  if (run.state !== 'awaiting_context') return fail('That run is not waiting on an answer.', { code: SERVICE_CODES.invalidInput });
  if (!run.request_id) return fail('That run has no request to continue.', { code: SERVICE_CODES.invalidInput });

  const requestId = run.request_id;
  const requestScope: ServiceScope = { ...scope, requestId, runId };
  const { data: requestRow, error: requestError } = await db.from('ai_requests').select('*').eq('id', requestId).eq('family_id', scope.familyId).maybeSingle();
  if (requestError) {
    console.error('[ai/intake] could not read the request to answer', requestError);
    return fail(describeDbError(requestError, 'Bubaly could not open that request.'), { code: SERVICE_CODES.db, retryable: true });
  }
  const request = requestRow as RequestRow | null;
  if (!request) return fail('That request could not be found.', { code: SERVICE_CODES.notFound });

  // Claim the run BEFORE anything is written, by compare-and-set from
  // `awaiting_context`. The state check above was a plain read: two answers
  // submitted together (two tabs, a retried POST) both pass it, and without
  // this claim both would record an answer, both would re-plan, and the
  // second would repoint a run the first had already started executing.
  const claimed = await updateRunWhereState(requestScope, runId, 'awaiting_context', { state: 'planning', status: legacyStatusFor('planning') }, { db });
  if (!claimed.ok) return claimed;
  if (!claimed.data) return fail('That answer is already being handled.', { code: SERVICE_CODES.invalidInput });

  const nowIso = new Date().toISOString();
  const clarifications = parseClarifications(request.clarifications);
  const open = [...clarifications].reverse().find((c) => !c.answer);
  if (open) { open.answer = reply; open.answered_at = nowIso; }
  else clarifications.push({ question: run.summary ?? '', reason: null, asked_at: nowIso, answer: reply, answered_at: nowIso });

  const recorded = await updateRequest(requestScope, requestId, { clarifications: clarifications as unknown as Json, status: 'planning' }, { db });
  if (!recorded.ok) {
    await parkAgain(requestScope, db, runId, requestId, run.summary ?? '');
    return recorded;
  }
  await appendEvent(requestScope, runId, { eventType: 'clarification_answered', message: reply, requestId }, { db });
  if (request.conversation_id) await recordConversationTurn(requestScope, db, request.conversation_id, requestId, { role: 'user', content: reply });

  const intent: IntentKey = isIntentKey(request.interpreted_intent) ? request.interpreted_intent : 'other';
  const context = await buildContext(requestScope, { intent, requestId });
  if (!context.ok) {
    await parkAgain(requestScope, db, runId, requestId, run.summary ?? '');
    return fail(context.error, { code: INTAKE_CODES.context, retryable: context.retryable });
  }

  const planned = settlePlanner(await withDeadline(
    planRequest(requestScope, { requestId, requestText: request.request_text, intent, context: context.data, conversationId: request.conversation_id, answers: answersFrom(clarifications, null) }),
    opts.plannerBudgetMs ?? DEFAULT_PLANNER_BUDGET_MS,
  ));
  if (!planned.ok) {
    // The answer is kept; the person can retry without typing it again.
    await parkAgain(requestScope, db, runId, requestId, run.summary ?? '');
    return fail(planned.error, { code: planned.code ?? INTAKE_CODES.planner, retryable: planned.retryable });
  }

  const outcome = planned.data;
  const conversationId = request.conversation_id;
  switch (outcome.kind) {
    case 'plan': {
      const continued = await adoptPlannedRun(requestScope, db, { placeholderRunId: runId, plannerRunId: outcome.runId, planId: outcome.planId, summary: outcome.summary });
      if (!continued.ok) return continued;
      const liveRunId = continued.data.runId;
      if (continued.data.live) {
        if (conversationId) await recordConversationTurn(requestScope, db, conversationId, requestId, { role: 'assistant', content: outcome.summary, card: runStatusCard(outcome, liveRunId) });
        kick(liveRunId, { budgetMs: executionBudgetMs(startedAt) });
      }
      return ok({ requestId, runId: liveRunId, planId: outcome.planId, outcome: 'plan', summary: outcome.summary, redirect: runPagePath(liveRunId) });
    }
    case 'clarification': {
      const reparked = await updateRun(requestScope, runId, { state: 'awaiting_context', status: legacyStatusFor('awaiting_context'), summary: outcome.question }, { db });
      if (!reparked.ok) return reparked;
      const parked = await parkForClarification(requestScope, db, { requestId, runId, question: outcome.question });
      if (!parked.ok) return parked;
      if (conversationId) await recordConversationTurn(requestScope, db, conversationId, requestId, { role: 'assistant', content: outcome.question, card: runStatusCard(outcome, runId) });
      return ok({ requestId, runId, planId: null, outcome: 'clarification', summary: outcome.question, question: outcome.question, redirect: runPagePath(runId) });
    }
    case 'recommendation':
    case 'answer': {
      const summary = outcome.kind === 'answer' ? outcome.text : outcome.summary;
      const closed = await updateRun(requestScope, runId, { state: 'completed', status: legacyStatusFor('completed'), summary, completed_at: nowIso }, { db });
      if (!closed.ok) return closed;
      const done = await updateRequest(requestScope, requestId, { status: 'completed', completed_at: nowIso }, { db });
      if (!done.ok) console.error('[ai/intake] could not close the answered request', done.error);
      await appendEvent(requestScope, runId, { eventType: 'run_completed', message: summary, requestId }, { db });
      if (conversationId) await recordConversationTurn(requestScope, db, conversationId, requestId, { role: 'assistant', content: summary, card: outcome.kind === 'answer' ? outcome.card ?? null : { kind: 'summary', title: summary } });
      return ok({ requestId, runId, planId: null, outcome: outcome.kind, summary, redirect: runPagePath(runId) });
    }
    default:
      await parkAgain(requestScope, db, runId, requestId, run.summary ?? '');
      console.error('[ai/intake] unknown planner outcome', outcome);
      return fail('Bubaly could not finish planning that request.', { code: INTAKE_CODES.planner });
  }
}

/** Put the run back in `awaiting_context` after a failed re-plan so the page still offers the answer box. */
async function parkAgain(scope: ServiceScope, db: DB, runId: string, requestId: string, question: string): Promise<void> {
  const run = await updateRun(scope, runId, { state: 'awaiting_context', status: legacyStatusFor('awaiting_context'), summary: question || null }, { db });
  if (!run.ok) console.error('[ai/intake] could not re-park the run', run.error);
  const request = await updateRequest(scope, requestId, { status: 'awaiting_context' }, { db });
  if (!request.ok) console.error('[ai/intake] could not re-park the request', request.error);
}

/**
 * Attach the planner's plan to the run the person is on, retiring the run the
 * planner created for it. Falls back to the planner's run when it has already
 * been claimed (or when the planner reused the same id).
 *
 * `live` is false when the placeholder left `planning` while the model was
 * thinking (a cancel from another tab is the realistic case): the plan is
 * left unattached and nothing is kicked, because attaching it would revive a
 * run the person already stopped.
 */
async function adoptPlannedRun(
  scope: ServiceScope,
  db: DB,
  args: { placeholderRunId: string; plannerRunId: string; planId: string; summary: string },
): Promise<ServiceResult<{ runId: string; live: boolean }>> {
  const { placeholderRunId, plannerRunId, planId, summary } = args;
  const nowIso = new Date().toISOString();

  if (plannerRunId !== placeholderRunId) {
    const { data: removed, error } = await db
      .from('family_automation_runs')
      .delete()
      .eq('id', plannerRunId)
      .eq('family_id', scope.familyId)
      .eq('state', 'ready')
      .is('lease_owner', null)
      .select('id');
    if (error) {
      console.error('[ai/intake] could not retire the planner run', error);
      return fail(describeDbError(error, 'Bubaly could not continue that run.'), { code: SERVICE_CODES.db, retryable: true });
    }
    if (!removed?.length) {
      // The cron got there first: the planner's run is already the live one.
      const closed = await updateRun(scope, placeholderRunId, { state: 'completed', status: legacyStatusFor('completed'), summary: 'Answered — Bubaly continued the work in a new run.', completed_at: nowIso }, { db });
      if (!closed.ok) return closed;
      await appendEvent(scope, placeholderRunId, { eventType: 'run_completed', message: 'Continued in a new run.', payload: { continuedAs: plannerRunId } }, { db });
      return ok({ runId: plannerRunId, live: true });
    }
  }

  // Compare-and-set from `planning` — the state `answerClarification` claimed
  // — so the plan is attached only to the run that is still ours to repoint.
  const attached = await updateRunWhereState(scope, placeholderRunId, 'planning', {
    plan_id: planId, state: 'ready', status: legacyStatusFor('ready'), summary, run_after: nowIso, error: null, lease_owner: null, lease_expires_at: null,
  }, { db });
  if (!attached.ok) return attached;
  if (!attached.data) {
    console.warn('[ai/intake] the run left planning before its plan was attached; nothing will run', { runId: placeholderRunId, planId });
    return ok({ runId: placeholderRunId, live: false });
  }
  await appendEvent(scope, placeholderRunId, { eventType: 'planned', message: summary, payload: { planId } }, { db });
  return ok({ runId: placeholderRunId, live: true });
}

// ─── Controls ───────────────────────────────────────────────────────────────

export type RunControlAction = 'pause' | 'resume' | 'cancel' | 'rerun';
export type RunControlResult = { action: RunControlAction; state: string; detail: string };

/**
 * One dispatcher for the four control routes and their server actions, so
 * the web UI and the mobile app get the same authority checks (in
 * `controls.ts`) and the same continuation after a resume or a re-run.
 */
export async function applyRunControl(
  scope: ServiceScope,
  runId: string,
  action: RunControlAction,
  args: { stepId?: string | null } = {},
  opts: IntakeOptions = {},
): Promise<ServiceResult<RunControlResult>> {
  const db = ledgerClient(scope, { db: opts.db });
  const kick = opts.kick ?? kickRun;
  const budgetMs = executionBudgetMs(opts.startedAtMs ?? Date.now());

  switch (action) {
    case 'pause': {
      const result = await pauseRun(scope, runId, { db });
      if (!result.ok) return result;
      return ok({ action, state: result.data.state, detail: 'Paused. Bubaly will not take further steps until you resume.' });
    }
    case 'resume': {
      const result = await resumeRun(scope, runId, { db });
      if (!result.ok) return result;
      kick(runId, { budgetMs });
      return ok({ action, state: result.data.state, detail: 'Resumed. Bubaly is picking up where it left off.' });
    }
    case 'cancel': {
      const result = await cancelRun(scope, runId, { db });
      if (!result.ok) return result;
      const parts = [
        result.data.cancelledSteps ? `${result.data.cancelledSteps} step${result.data.cancelledSteps === 1 ? '' : 's'} will not run` : null,
        result.data.cancelledApprovals ? `${result.data.cancelledApprovals} approval${result.data.cancelledApprovals === 1 ? '' : 's'} withdrawn` : null,
      ].filter(Boolean);
      return ok({ action, state: result.data.state, detail: parts.length ? `Cancelled — ${parts.join(', ')}.` : 'Cancelled.' });
    }
    case 'rerun': {
      const stepId = args.stepId?.trim();
      if (!stepId) return fail('Choose the step to run again.', { code: SERVICE_CODES.invalidInput });
      const result = await rerunStep(scope, runId, stepId, { db });
      if (!result.ok) return result;
      if (result.data.rerun) kick(runId, { budgetMs });
      return ok({ action, state: result.data.state, detail: result.data.detail });
    }
  }
}

/** HTTP status for a service failure surfaced by a run route. */
export function statusForServiceCode(code: string | undefined, retryable?: boolean): number {
  switch (code) {
    case SERVICE_CODES.notFound: return 404;
    case SERVICE_CODES.denied: return 403;
    case SERVICE_CODES.invalidInput: return 409;
    case INTAKE_CODES.inProgress: return 409;
    case INTAKE_CODES.timeout: return 504;
    case 'unconfigured': return 503;
    case SERVICE_CODES.db: return retryable ? 503 : 500;
    default: return retryable ? 503 : 502;
  }
}
