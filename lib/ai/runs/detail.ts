// lib/ai/runs/detail.ts — the run detail read model behind GET /api/ai/runs/[id]
// and the run page (§17).
//
// Built on `store.loadRunDetail` (run, plan, steps, events) and widened with
// the request that started the run and the approvals it opened, because the
// page renders the question the person asked, the clarification it may be
// waiting on, and the approval cards inline.
//
// The client passed in is the CALLER'S RLS-bound client on purpose. A run from
// another family must come back as `null` — the route turns that into a 404 —
// rather than as a 403 that confirms the id exists. Every statement still
// filters `family_id` explicitly so the same function is correct when a
// server action hands it the service client.
//
// `RunDetailView` is the server-side read: raw rows. What leaves the server —
// through the page, the GET route and the `loadRunAction` refresh alike — is
// the `RunView` built by `toRunView` below: step descriptions, event messages,
// the plan's reasoning_summary. Never the model's reasoning, step inputs and
// results, event payloads, the run's lease and result columns, or the
// request's clarification log and token counts. One boundary, three readers,
// so the route cannot leak what the page deliberately strips
// (tests/run-detail-read-boundary.test.ts pins this).
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { editableFieldsFor, type EditableField } from '@/lib/approvals/card-data';
import { isManager } from '@/lib/constants/roles';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult } from '@/lib/services/types';
import { toCardData, type ApprovalCardData } from '@/lib/services/approvals';
import { scopeForSystem } from '@/lib/services/scope';
import { describeProgress, displayRunState, summarizeSteps, type RunState, type StepState } from './states';
import {
  loadRunDetail as loadRunCore, type PlanRow, type RequestRow, type RunEventRow, type RunRow, type StepRow,
} from './store';

type DB = SupabaseClient<Database>;
type ApprovalRow = Database['public']['Tables']['approval_requests']['Row'];

export type RunDetailView = {
  run: RunRow;
  request: RequestRow | null;
  plan: PlanRow | null;
  steps: StepRow[];
  events: RunEventRow[];
  approvals: ApprovalCardData[];
};

export type LoadRunDetailOptions = {
  /** The viewer's role decides `canEdit` on the approval cards; omit for a read that renders no controls. */
  viewerRole?: string | null;
  eventLimit?: number;
};

/**
 * Everything the run page shows, or `null` when the run is not this family's.
 * Reads fail closed: a run header without its steps would render as an empty,
 * finished-looking run.
 */
export async function loadRunDetail(
  db: DB,
  familyId: string,
  runId: string,
  opts: LoadRunDetailOptions = {},
): Promise<ServiceResult<RunDetailView | null>> {
  // `loadRunCore` only reads `familyId` and the client off the scope; the
  // system scope is the cheapest way to hand it exactly those two.
  const core = await loadRunCore(scopeForSystem(db, { id: familyId }), runId, { db, eventLimit: opts.eventLimit });
  if (!core.ok) return core;
  if (!core.data) return ok(null);
  const { run, plan, steps, events } = core.data;

  const [{ data: request, error: requestError }, { data: approvalRows, error: approvalError }] = await Promise.all([
    run.request_id
      ? db.from('ai_requests').select('*').eq('id', run.request_id).eq('family_id', familyId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from('approval_requests').select('*').eq('family_id', familyId).eq('run_id', runId).order('created_at', { ascending: true }),
  ]);
  const readError = requestError ?? approvalError;
  if (readError) {
    console.error('[ai/runs] failed to read the run detail request/approvals', readError);
    return fail(describeDbError(readError, 'Bubaly could not open that run.'), { code: SERVICE_CODES.db, retryable: true });
  }

  const approvals = (approvalRows ?? []) as ApprovalRow[];
  const names = new Map<string, string>();
  const memberIds = [...new Set(approvals.map((a) => a.requested_by_member_id).filter((id): id is string => !!id))];
  if (memberIds.length) {
    const { data: members, error: memberError } = await db
      .from('family_members').select('id, display_name').eq('family_id', familyId).in('id', memberIds);
    // A missing requester name is cosmetic; the run itself still opens.
    if (memberError) console.error('[ai/runs] failed to resolve approval requester names', memberError);
    for (const m of members ?? []) names.set(m.id, m.display_name);
  }
  const canEdit = isManager(opts.viewerRole);

  return ok({
    run,
    request: (request as RequestRow | null) ?? null,
    plan,
    steps,
    events,
    approvals: approvals.map((row) => toCardData(row, { requestedBy: row.requested_by_member_id ? names.get(row.requested_by_member_id) ?? null : null, canEdit })),
  });
}

// ─── The read boundary ──────────────────────────────────────────────────────

export type RunStepView = {
  id: string;
  sequence: number;
  description: string;
  status: StepState;
  /** The executor's user-facing failure line, when the step failed. */
  error: string | null;
  /** Managers only: the scalar inputs the Edit modal may change. */
  editableFields?: EditableField[];
};

export type RunEventView = {
  id: string;
  type: string;
  message: string;
  at: string;
  stepId: string | null;
  actor: 'ai' | 'member' | 'system';
  /** For `model_call` events only: "1.2s · 850 tokens". Never the prompt or the reply. */
  metrics: string | null;
};

export type RunProgressView = {
  done: number;
  total: number;
  failed: number;
  blocked: number;
  awaitingApproval: number;
  /** "12 of 18 steps completed." */
  label: string;
};

export type RunView = {
  id: string;
  familyId: string;
  planId: string | null;
  requestId: string | null;
  state: RunState;
  objective: string;
  requestText: string | null;
  requestedBy: string | null;
  /** The plan's user-facing "why" — `ai_plans.reasoning_summary`, never chain-of-thought. */
  reasoningSummary: string | null;
  riskLevel: 'low' | 'medium' | 'high';
  progress: RunProgressView;
  /** The run's own failure line (`family_automation_runs.error`), when it failed or blocked. */
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  steps: RunStepView[];
  events: RunEventView[];
  approvals: ApprovalCardData[];
  /** The question Bubaly is waiting on, when the run is `awaiting_context`. */
  question: string | null;
  answered: { question: string; answer: string }[];
};

/** Step states a manager may still change before they run (or run again). */
export const EDITABLE_STEP_STATES: readonly StepState[] = ['queued', 'ready', 'awaiting_approval', 'failed', 'blocked', 'cancelled'];

/** "1.2s · 850 tokens" — the only fields of a `model_call` payload a reader gets. */
function modelCallMetrics(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const rec = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.latency_ms === 'number' && Number.isFinite(rec.latency_ms)) parts.push(`${(rec.latency_ms / 1000).toFixed(1)}s`);
  if (typeof rec.total_tokens === 'number' && Number.isFinite(rec.total_tokens)) parts.push(`${rec.total_tokens} tokens`);
  return parts.length ? parts.join(' · ') : null;
}

type Clarification = { question: string; answer: string | null };

function clarificationsOf(raw: unknown): Clarification[] {
  if (!Array.isArray(raw)) return [];
  const out: Clarification[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.question !== 'string' || !rec.question.trim()) continue;
    out.push({ question: rec.question, answer: typeof rec.answer === 'string' && rec.answer.trim() ? rec.answer : null });
  }
  return out;
}

function stepDescription(step: RunDetailView['steps'][number]): string {
  return step.description?.trim() || 'A step Bubaly planned';
}

/**
 * The read boundary: everything a reader outside the server gets to see about
 * a run. `manager` decides whether step inputs are offered as editable scalar
 * fields (and only for steps that may still change); nothing else about the
 * inputs crosses.
 */
export function toRunView(detail: RunDetailView, familyId: string, manager: boolean): RunView {
  const { run, request, plan, steps, events, approvals } = detail;
  const state = displayRunState(run);
  const counts = summarizeSteps(steps.map((s) => ({ id: s.id, status: s.status as StepState, dependency_ids: s.dependency_ids, sequence: s.sequence })));
  const clarifications = clarificationsOf(request?.clarifications);
  const open = state === 'awaiting_context' ? clarifications.find((c) => !c.answer) ?? null : null;

  const stepViews: RunStepView[] = steps.map((s) => {
    const view: RunStepView = { id: s.id, sequence: s.sequence, description: stepDescription(s), status: s.status as StepState, error: s.error };
    if (manager && EDITABLE_STEP_STATES.includes(s.status as StepState) && (s.step_type === 'act' || s.step_type === 'notify')) {
      const input = s.input_json && typeof s.input_json === 'object' && !Array.isArray(s.input_json) ? (s.input_json as Record<string, unknown>) : null;
      const fields = editableFieldsFor(input);
      if (fields.length) view.editableFields = fields;
    }
    return view;
  });

  const eventViews: RunEventView[] = events.map((e) => ({
    id: e.id,
    type: e.event_type,
    message: e.message,
    at: e.created_at,
    stepId: e.step_id,
    actor: e.actor_kind as RunEventView['actor'],
    metrics: e.event_type === 'model_call' ? modelCallMetrics(e.payload) : null,
  }));

  return {
    id: run.id,
    familyId,
    planId: run.plan_id,
    requestId: run.request_id,
    state,
    objective: plan?.objective?.trim() || run.summary?.trim() || request?.request_text?.trim() || 'Your request',
    requestText: request?.request_text?.trim() || null,
    requestedBy: null,
    reasoningSummary: plan?.reasoning_summary?.trim() || null,
    riskLevel: (plan?.risk_level as RunView['riskLevel']) ?? 'low',
    progress: {
      done: counts.completed + counts.skipped,
      total: counts.total,
      failed: counts.failed,
      blocked: counts.blocked,
      awaitingApproval: counts.awaitingApproval,
      label: describeProgress(counts),
    },
    error: state === 'failed' || state === 'blocked' ? run.error : null,
    createdAt: run.created_at,
    completedAt: run.completed_at,
    steps: stepViews,
    events: eventViews,
    approvals,
    question: open?.question ?? null,
    answered: clarifications.filter((c): c is { question: string; answer: string } => !!c.answer),
  };
}
