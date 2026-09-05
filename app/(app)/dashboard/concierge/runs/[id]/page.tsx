// The run page (§17): objective, state, "12 of 18 steps complete", a readable
// timeline, the approvals and the question the run is waiting on, and the
// controls — rendered on the server first so a refresh never loses state
// (§45 Persistence), then kept live by the timeline's Realtime subscription.
//
// This page is the ONLY reader for the run detail UI, and it reads through the
// family-scoped `loadRunDetail` with the caller's own client: a run from
// another family is `null` and becomes a 404, never a 403 that confirms the id
// exists. What crosses to the browser is the `RunView` built by `toRunView`
// below — step descriptions, event messages, the plan's reasoning_summary —
// never the model's reasoning, step inputs/results or event payloads
// (tests/run-detail-read-boundary.test.ts pins this).
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { assertAIAccess } from '@/lib/server/ai-access';
import { isManager } from '@/lib/constants/roles';
import { scopeFromUserContext } from '@/lib/services/scope';
import { loadRunDetail, type RunDetailView } from '@/lib/ai/runs/detail';
import { editStepInput } from '@/lib/ai/runs/controls';
import { kickRun } from '@/lib/ai/runs/continue';
import { describeProgress, displayRunState, summarizeSteps, type StepState } from '@/lib/ai/runs/states';
import { runPagePath } from '@/lib/ai/chat-request';
import { editableFieldsFor } from '@/lib/approvals/card-data';
import type { RunActionResult } from '@/app/(app)/dashboard/concierge/run-actions';
import { ErrorState } from '@/components/ui/states';
import { ApprovalCard } from '@/components/approvals/approval-card';
import { StatusBadge } from '@/components/concierge/status-badge';
import { RunTimeline, type RunEventView, type RunStepView, type RunView } from '@/components/concierge/run-timeline';
import { RunControls, type EditableStep, type FailedStep } from '@/components/concierge/run-controls';
import { ClarificationCard } from '@/components/concierge/clarification-card';

export const metadata: Metadata = { title: 'Bubaly is on it' };
export const dynamic = 'force-dynamic';

/** Step states a manager may still change before they run (or run again). */
const EDITABLE_STEP_STATES: readonly StepState[] = ['queued', 'ready', 'awaiting_approval', 'failed', 'blocked', 'cancelled'];
const RERUNNABLE_STEP_STATES: readonly StepState[] = ['failed', 'blocked', 'cancelled'];

/** "1.2s · 850 tokens" — the only fields of a `model_call` payload the page reads. */
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

/** The read boundary: everything the browser gets to see about a run. */
function toRunView(detail: RunDetailView, familyId: string, manager: boolean): RunView {
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

function RunUnavailable({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <Link href="/home" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-fg coarse:min-h-11">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Home
      </Link>
      <ErrorState message={message} />
    </div>
  );
}

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) notFound();

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const manager = isManager(ctx.active.role);

  const access = await assertAIAccess(ctx, { db: supabase });
  if (!access.ok) {
    if (access.status === 404) notFound();
    return <RunUnavailable message={access.error} />;
  }

  const detail = await loadRunDetail(supabase, familyId, id, { viewerRole: ctx.active.role });
  if (!detail.ok) return <RunUnavailable message={detail.error} />;
  if (!detail.data) notFound();

  const runId = detail.data.run.id;
  const requestId = detail.data.run.request_id;
  const canControl = manager || detail.data.run.requested_by_member_id === ctx.active.member.id;
  const view = toRunView(detail.data, familyId, manager);

  const failedSteps: FailedStep[] = view.steps
    .filter((s) => RERUNNABLE_STEP_STATES.includes(s.status))
    .map((s) => ({ id: s.id, description: s.description }));
  const editableSteps: EditableStep[] = view.steps
    .filter((s) => (s.editableFields?.length ?? 0) > 0)
    .map((s) => ({ id: s.id, description: s.description, fields: s.editableFields ?? [] }));

  /**
   * Edit a step's scalar inputs (managers; re-checked inside `editStepInput`).
   * The browser sends only the changed fields; they are merged over the stored
   * input here so a value the form never showed cannot be dropped. The edited
   * plan becomes a new version and the run is kicked so it continues without
   * waiting for the next cron tick.
   */
  async function editStepAction(stepId: string, edits: Record<string, string | number | boolean>): Promise<RunActionResult<{ requeuedSteps: number }>> {
    'use server';
    const actor = await requireUserContext();
    const db = await createServer();
    if (actor.active.familyId !== familyId) return { ok: false, error: 'That run could not be found.', code: 'not_found' };
    if (!edits || typeof edits !== 'object' || Array.isArray(edits)) return { ok: false, error: 'Nothing to change.', code: 'invalid_input' };

    const current = await loadRunDetail(db, familyId, runId, { viewerRole: actor.active.role });
    if (!current.ok) return { ok: false, error: current.error, code: current.code };
    const step = current.data?.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: 'That step is not part of this run.', code: 'not_found' };
    const allowed = new Set(editableFieldsFor(step.input_json as Record<string, unknown>).map((f) => f.key));
    const merged: Record<string, unknown> = { ...(step.input_json as Record<string, unknown>) };
    for (const [key, value] of Object.entries(edits)) {
      if (!allowed.has(key)) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      merged[key] = value;
    }

    const result = await editStepInput(scopeFromUserContext(actor, db), runId, stepId, merged);
    if (!result.ok) return { ok: false, error: result.error, code: result.code };
    kickRun(runId);
    revalidatePath(runPagePath(runId));
    revalidatePath('/home');
    revalidatePath('/dashboard');
    return { ok: true, data: { requeuedSteps: result.data.requeuedSteps } };
  }

  // The loader returns every approval the run opened, decided ones included,
  // and the card has no status of its own. A step in `awaiting_approval`
  // points at the approval that is actually open, so only those are shown;
  // if the run is parked with no step pointing anywhere (a plan-level gate),
  // every card is shown rather than none.
  const openApprovalIds = new Set(
    detail.data.steps.filter((s) => s.status === 'awaiting_approval' && s.approval_id).map((s) => s.approval_id as string),
  );
  const pendingApprovals = openApprovalIds.size > 0
    ? view.approvals.filter((a) => openApprovalIds.has(a.id))
    : view.state === 'awaiting_approval' ? view.approvals : [];
  const showActivity = manager;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 pb-28">
      <Link href="/home" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-fg coarse:min-h-11">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Home
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge state={view.state} />
          {requestId === null && <span className="text-xs text-muted">Started by a routine</span>}
        </div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl lg:text-3xl">{view.objective}</h1>
        {view.requestText && view.requestText !== view.objective && (
          <p className="text-sm text-muted">You asked: “{view.requestText}”</p>
        )}
        {view.reasoningSummary && (
          <p className="flex gap-2 rounded-2xl border border-brand/20 bg-brand/5 px-4 py-3 text-sm text-fg/90">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-text" aria-hidden />
            <span>{view.reasoningSummary}</span>
          </p>
        )}
        {view.error && <ErrorState message={view.error} />}
      </header>

      <RunControls
        runId={runId}
        state={view.state}
        canControl={canControl}
        canManage={manager}
        failedSteps={failedSteps}
        editableSteps={editableSteps}
        onEditStep={editStepAction}
      />

      {view.question && (
        <ClarificationCard runId={runId} question={view.question} answered={view.answered} canAnswer={canControl} />
      )}

      {pendingApprovals.length > 0 && (
        <section aria-label="Approvals" className="space-y-2">
          {pendingApprovals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} canDecide={manager} />
          ))}
        </section>
      )}

      <section aria-label="Progress" className="rounded-2xl border border-border bg-surface/40 p-4 sm:p-5">
        <RunTimeline view={view} showActivity={showActivity} />
      </section>
    </div>
  );
}
