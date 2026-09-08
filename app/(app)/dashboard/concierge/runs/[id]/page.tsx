// The run page (§17): objective, state, "12 of 18 steps complete", a readable
// timeline, the approvals and the question the run is waiting on, and the
// controls — rendered on the server first so a refresh never loses state
// (§45 Persistence), then kept live by the timeline's Realtime subscription.
//
// This page reads through the family-scoped `loadRunDetail` with the caller's
// own client: a run from another family is `null` and becomes a 404, never a
// 403 that confirms the id exists. What crosses to the browser is the
// `RunView` built by `toRunView` in lib/ai/runs/detail.ts — the same boundary
// the GET route and the refresh action use — step descriptions, event
// messages, the plan's reasoning_summary; never the model's reasoning, step
// inputs/results or event payloads (tests/run-detail-read-boundary.test.ts
// pins this).
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
import { loadRunDetail, toRunView } from '@/lib/ai/runs/detail';
import { editStepInput } from '@/lib/ai/runs/controls';
import { kickRun } from '@/lib/ai/runs/continue';
import type { StepState } from '@/lib/ai/runs/states';
import { runPagePath } from '@/lib/ai/chat-request';
import { toolDomain } from '@/lib/ai/tool-domains';
import { editableFieldsFor } from '@/lib/approvals/card-data';
import type { RunActionResult } from '@/app/(app)/dashboard/concierge/run-actions';
import { ErrorState } from '@/components/ui/states';
import { ApprovalCard } from '@/components/approvals/approval-card';
import { StatusBadge } from '@/components/concierge/status-badge';
import { RunTimeline, type StepSources } from '@/components/concierge/run-timeline';
import { RunControls, type EditableStep, type FailedStep } from '@/components/concierge/run-controls';
import { ClarificationCard } from '@/components/concierge/clarification-card';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Bubaly is on it' };
export const dynamic = 'force-dynamic';

const RERUNNABLE_STEP_STATES: readonly StepState[] = ['failed', 'blocked', 'cancelled'];

async function RunUnavailable({ message }: { message: string }) {
  const t = await getTranslations();
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <Link href="/home" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-fg coarse:min-h-11">
        <ArrowLeft className="h-4 w-4" aria-hidden />{' '}{t('runs.home')}</Link>
      <ErrorState message={message} />
    </div>
  );
}

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations();
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
  // M6: which tool each step runs, from the persisted `tool_name` — the source
  // shown beside the step. Passed apart from the view so the read boundary
  // stays exactly what tests/run-detail-read-boundary.test.ts pins.
  const stepSources: StepSources = Object.fromEntries(
    detail.data.steps
      .filter((s) => !!s.tool_name?.trim())
      .map((s) => [s.id, { tool: (s.tool_name as string).trim(), domain: toolDomain(s.tool_name as string) }]),
  );

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
    // Resolve the translator INSIDE the action. An inline server action closes
    // over the enclosing scope, and Next serialises that closure to hand the
    // action to the client — a function cannot be serialised, so capturing the
    // page's `t` threw "Functions cannot be passed directly to Client
    // Components" while rendering and took this route down.
    const t = await getTranslations();
    const actor = await requireUserContext();
    const db = await createServer();
    if (actor.active.familyId !== familyId) return { ok: false, error: t('runs.thatRunCouldNotBe'), code: 'not_found' };
    if (!edits || typeof edits !== 'object' || Array.isArray(edits)) return { ok: false, error: t('runs.nothingToChange'), code: 'invalid_input' };

    const current = await loadRunDetail(db, familyId, runId, { viewerRole: actor.active.role });
    if (!current.ok) return { ok: false, error: current.error, code: current.code };
    const step = current.data?.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: t('runs.thatStepIsNotPart'), code: 'not_found' };
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
        <ArrowLeft className="h-4 w-4" aria-hidden /> {t('dashboardConciergeRuns.home')}
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge state={view.state} />
          {requestId === null && <span className="text-xs text-muted">{t('dashboardConciergeRuns.startedByARoutine')}</span>}
        </div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl lg:text-3xl">{view.objective}</h1>
        {view.requestText && view.requestText !== view.objective && (
          <p className="text-sm text-muted">{t('dashboardConciergeRuns.youAsked')}{view.requestText}”</p>
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
        <section aria-label={t('dashboardConciergeRuns.approvals')} className="space-y-2">
          {pendingApprovals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} canDecide={manager} />
          ))}
        </section>
      )}

      <section aria-label={t('dashboardConciergeRuns.progress')} className="rounded-2xl border border-border bg-surface/40 p-4 sm:p-5">
        <RunTimeline view={view} showActivity={showActivity} stepSources={stepSources} />
      </section>
    </div>
  );
}
