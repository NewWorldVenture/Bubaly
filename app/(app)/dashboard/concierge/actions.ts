'use server';

// Concierge write-backs + the AUTONOMOUS EXECUTION LOOP.
//
// Manual path (unchanged): "Make it happen" buttons materialize an accepted
// plan into real records (calendar event · reminder · prep task), each logged
// to concierge_plan_actions so the flow is idempotent and auditable.
//
// Autonomous path (the loop): when a plan is ACCEPTED (status → booked/
// confirmed), planAcceptedAction consults the family's Trust & Permissions
// policies (0093 engine, domain 'scheduling' × capability 'automate', AI actor)
// and — per the family's autopilot dial — EXECUTES the write-backs immediately,
// queues them for one-tap approval (approval_requests + a pending
// family_automation_runs row), or stays hands-off. Every autonomous run is
// audited in family_automation_runs (0022) with its trust reasoning, so the
// family always sees what Bubaly did and why. No new schema.
import { revalidatePath } from 'next/cache';
import type { PostgrestError } from '@supabase/supabase-js';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { availableWriteBackKinds, type WriteBackKind } from '@/lib/concierge/apply';
import { decide, materializeConciergePlan, type MaterializeResult } from '@/lib/services/approvals';
import { classifyPayload } from '@/lib/approvals/card-data';
import { legacyStatusFor } from '@/lib/ai/runs/states';
import {
  AUTOPILOT_AGENT, AUTOPILOT_CAPABILITY, AUTOPILOT_DOMAIN, AUTOPILOT_POLICY_NAME,
  approvalTitle, autonomyMode, dialEffect, isAcceptance, runFailureSummary, runSummary,
  type AutonomyMode, type AutopilotLevel,
} from '@/lib/autonomy/loop';
import { evaluateTrust, roleOf } from '@/lib/trust/server';
import { behaviorForDomain } from '@/lib/ai/family-settings';
import { loadAISettings } from '@/lib/services/ai-settings';
import { scopeFromUserContext } from '@/lib/services/scope';

type Result = { ok: true; applied: WriteBackKind[] } | { ok: false; error: string };

const VALID: WriteBackKind[] = ['calendar', 'reminder', 'task'];
const PATH = '/dashboard/concierge';

type PlanRow = {
  id: string; title: string; description: string | null; location: string | null;
  planned_for: string | null; budget_cents: number | null;
};
type DB = Awaited<ReturnType<typeof createServer>>;

/**
 * Shared materializer. The insert logic lives in the approvals service
 * (`materializeConciergePlan`) because an approved `concierge_plan` payload
 * must create exactly the same records the manual buttons do — one ledger
 * (`concierge_plan_actions`), one set of rules, no drift between the two paths.
 */
async function materializePlan(
  sb: DB, familyId: string, userId: string, plan: PlanRow, kinds: WriteBackKind[],
): Promise<MaterializeResult> {
  return materializeConciergePlan(sb, familyId, userId, plan, kinds);
}

/**
 * Manual apply — the existing "Make it happen" buttons. Unchanged behavior.
 */
export async function applyConciergePlanAction(planId: string, kinds: WriteBackKind[]): Promise<Result> {
  const t = await getTranslations();
  if (!planId) return { ok: false, error: t('actions.invalidPlan') };
  const requested = kinds.filter((k): k is WriteBackKind => VALID.includes(k));
  if (requested.length === 0) return { ok: false, error: t('actions.nothingToApply') };

  const ctx = await requireUserContext();
  const sb = await createServer();

  // A refused read answered "Plan not found" — a claim about the plan, from a
  // read that never saw it. Audit C1-S9-72.
  const { data: plan, error: planReadErr } = await sb
    .from('concierge_plans')
    .select('id, title, description, location, planned_for, budget_cents')
    .eq('id', planId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();
  if (planReadErr) return { ok: false, error: describeActionError(planReadErr, t('actions.couldNotLoadThatPlan')) };
  if (!plan) return { ok: false, error: t('actions.planNotFound') };

  const { applied, failed } = await materializePlan(sb, ctx.active.familyId, ctx.user.id, plan, requested);
  revalidatePath(PATH);
  // The button reads an empty `applied` as "already applied" and ticks itself
  // done, so a refused write must not reach it as ok. Audit C1-S9-72.
  if (failed.length) return { ok: false, error: t('actions.couldNotFinishApplyingPlan') };
  return { ok: true, applied };
}

// ── The autonomous loop ──────────────────────────────────────────────────────

export type LoopResult =
  | { ok: true; mode: AutonomyMode; applied: WriteBackKind[]; summary: string | null }
  // `code` names a refusal another surface words differently (the automation
  // pages' button says "Skip" where this panel's says "Dismiss").
  | { ok: false; error: string; code?: 'approval_already_decided' };

/**
 * Fired when a plan's status transitions into booked/confirmed. Consults the
 * trust engine and either executes now (audited run), queues for approval
 * (pending run + approval request), or does nothing (dial off / not an
 * acceptance transition).
 */
export async function planAcceptedAction(
  planId: string, prevStatus: string, nextStatus: string,
): Promise<LoopResult> {
  const t = await getTranslations();
  if (!planId) return { ok: false, error: t('actions.invalidPlan') };
  if (!isAcceptance(prevStatus, nextStatus)) return { ok: true, mode: 'off', applied: [], summary: null };

  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;

  const { data: plan, error: planReadErr } = await sb
    .from('concierge_plans')
    .select('id, title, description, location, planned_for, budget_cents, status')
    .eq('id', planId)
    .eq('family_id', familyId)
    .maybeSingle();
  if (planReadErr) return { ok: false, error: describeActionError(planReadErr, t('actions.couldNotLoadThatPlan')) };
  if (!plan) return { ok: false, error: t('actions.planNotFound') };
  // `nextStatus` is the caller's word. The loop acts on the plan's persisted
  // status, so an acceptance that never landed — or a call that only claims
  // one — materialises nothing. Audit C1-S9-77.
  if (plan.status !== nextStatus) return { ok: true, mode: 'off', applied: [], summary: null };

  // Nothing new to do? Don't open approvals for a no-op.
  //
  // This is a pre-check, not the authority: materializePlan re-reads the same
  // ledger and refuses on error. So a refused read here is logged and treated
  // as "nothing applied yet" — the worst case is an approval that turns out to
  // be a no-op, which is smaller than dropping an accepted plan. Audit C1-S9-72.
  const kinds = availableWriteBackKinds(plan);
  const { data: existing, error: existingErr } = await sb
    .from('concierge_plan_actions').select('action_kind')
    .eq('family_id', familyId).eq('plan_id', planId);
  if (existingErr) console.error('[concierge] write-back ledger pre-check failed; proceeding', { planId, familyId, error: existingErr });
  const already = new Set((existing ?? []).map((r) => r.action_kind));
  const pendingKinds = kinds.filter((k) => !already.has(k));
  if (pendingKinds.length === 0) return { ok: true, mode: 'off', applied: [], summary: null };

  // The family's own settings, not just their trust policies (0257). This path
  // materialises calendar events and reminders on `auto`, and it used to read
  // neither the master switch nor the scheduling dial — so "Switch Bubaly off"
  // left accepted plans still writing themselves into the calendar.
  //
  // Read STRICTLY, and before the engine: the forgiving read answered a failed
  // query with the defaults — "Bubaly on", `execute` — so a timeout let a
  // switched-off family's plan write itself in (SEC-009). A read that failed
  // does nothing, opens no approval, and says so.
  const read = await loadAISettings(scopeFromUserContext(ctx, sb));
  if (!read.ok) return { ok: false, error: t('aiSettings.readFailedNothingChanged') };
  const settings = read.data;

  // Ask the family's own trust policies what the AI may do here.
  const { decision, approvalId } = await evaluateTrust(sb, familyId, {
    actor: { kind: 'ai_agent', id: AUTOPILOT_AGENT, role: roleOf(ctx.active.role) },
    domain: AUTOPILOT_DOMAIN,
    capability: AUTOPILOT_CAPABILITY,
    agent: 'Concierge',
    title: approvalTitle(plan.title),
    summary: `Materialize the accepted plan across surfaces: ${pendingKinds.join(' + ')}.`,
    payload: { plan_id: planId, kinds: pendingKinds },
    context: { amountCents: plan.budget_cents ?? undefined },
  });
  const behavior = behaviorForDomain(settings, AUTOPILOT_DOMAIN);
  const mode = !settings.enabled
    ? 'off'
    : behavior === 'recommend'
      ? 'off'
      : behavior === 'prepare'
        ? (autonomyMode(decision) === 'off' ? 'off' : 'ask')
        : autonomyMode(decision);

  if (mode === 'auto') {
    const { applied, failed } = await materializePlan(sb, familyId, ctx.user.id, plan, pendingKinds);
    // A failure used to be recorded as `executed` / `completed` under
    // "everything was already in place". It is recorded as what it was, and
    // the plan's own buttons stay the retry. Audit C1-S9-72.
    const state = failed.length === 0 ? 'completed' : applied.length ? 'partially_completed' : 'failed';
    const summary = failed.length ? runFailureSummary(plan.title, applied, failed) : runSummary(plan.title, applied);
    // Written by the server: 0252 only lets a member file their own unplanned
    // queued run, and this row records work Bubaly already did. Logged, not
    // raised: the records exist by now, and failing the action would report
    // failure for work that succeeded.
    // `completed_at` is not decoration: it is the only column the family's value
    // metric will count. lib/metric/completed-plans.ts filters the 7-day
    // headline on `completed_at`, and a row without one lands in the "excluded,
    // week unknown" bucket permanently — so the Finances card, the upgrade
    // paywall's value card and the Display's "Handled today" tile all read 0
    // for work Bubaly just did. The row records a run that has already ended —
    // completed, partially completed or failed are each terminal (C1-S9-72) —
    // so the end time is now; only `state = 'completed'` is counted as done.
    const { error: recordErr } = await createServiceClient().from('family_automation_runs').insert({
      family_id: familyId, trigger_type: 'plan_accepted', status: legacyStatusFor(state), state,
      completed_at: new Date().toISOString(),
      requested_by_member_id: ctx.active.member.id,
      summary, result: { steps: applied, failed } as never,
      metadata: { plan_id: planId, basis: decision.basis, reason: decision.reason } as never,
      created_by: ctx.user.id,
    });
    if (recordErr) console.error('[concierge] autopilot run record failed', { planId, familyId, state, error: recordErr });
    revalidatePath(PATH);
    if (failed.length) return { ok: false, error: t('actions.couldNotFinishApplyingPlan') };
    return { ok: true, mode, applied, summary };
  }

  if (mode === 'ask') {
    const summary = `Waiting for approval: ${approvalTitle(plan.title)}`;
    // The caller answers "check the Autopilot panel", and this row is the only
    // thing that panel reads — so a refused insert is not a queued plan.
    // Audit C1-S9-72.
    const { error: queueErr } = await createServiceClient().from('family_automation_runs').insert({
      family_id: familyId, trigger_type: 'plan_accepted', status: 'pending', state: 'awaiting_approval',
      requested_by_member_id: ctx.active.member.id,
      summary,
      result: {} as never,
      metadata: {
        plan_id: planId, kinds: pendingKinds, approval_id: approvalId ?? null,
        basis: decision.basis, reason: decision.reason,
      } as never,
      created_by: ctx.user.id,
    });
    if (queueErr) {
      console.error('[concierge] autopilot queue insert failed', { planId, familyId, approvalId: approvalId ?? null, error: queueErr });
      return { ok: false, error: describeActionError(queueErr, t('actions.couldNotQueuePlanForApproval')) };
    }
    revalidatePath(PATH);
    return { ok: true, mode, applied: [], summary };
  }

  return { ok: true, mode: 'off', applied: [], summary: null };
}

type RunMeta = { plan_id?: string; kinds?: WriteBackKind[]; approval_id?: string | null };
type GoverningApproval = { id: string; status: string; expires_at: string | null };

/**
 * The approval that governs a queued run — read from `approval_requests`, the
 * table the trust engine writes and 0381/0389 defend, and NEVER from the run's
 * own `metadata`.
 *
 * `metadata.approval_id` used to decide whether a vote was needed at all. It is
 * a column on a row the same manager may UPDATE (`family_automation_runs_update`,
 * 0251, names no column) and may INSERT afresh (0255/0329 let a manager file a
 * 'queued' run whose `status` defaults to 'pending' and whose metadata is
 * free). So one PATCH that dropped the key, or one INSERT that never had it,
 * turned a two-parent plan into a one-tap materialisation while the real
 * approval stayed pending on the other parent's card. 0390 pins the key on
 * server-written rows; it cannot pin a row born without one, which is why the
 * link is resolved here from the other side.
 *
 * The link is the plan: planAcceptedAction files the approval with
 * `payload = {plan_id, kinds}` (lib/trust/server.ts openApprovalRequest), and
 * 0389 freezes `payload` for the life of the row. Newest first, a pending row
 * preferred — a plan re-accepted after a decline has a new approval, and that
 * is the one that governs.
 *
 * `null` means no approval row names this plan at all: the run was never gated
 * (the autopilot dial downgraded an `allow` to "ask"), and there is no
 * threshold to honour.
 */
async function governingApprovalFor(
  sb: DB, familyId: string, planId: string,
): Promise<{ ok: true; approval: GoverningApproval | null } | { ok: false; error: PostgrestError }> {
  const { data, error } = await sb
    .from('approval_requests')
    .select('id, status, expires_at, payload, payload_kind, created_at')
    .eq('family_id', familyId)
    .filter('payload->>plan_id', 'eq', planId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return { ok: false, error };
  const rows = (data ?? []).filter((row) =>
    classifyPayload({ payload: row.payload, payload_kind: row.payload_kind, run_id: null, plan_step_id: null, plan_step_ids: null })?.kind === 'concierge_plan');
  const governing = rows.find((row) => row.status === 'pending') ?? rows[0] ?? null;
  return { ok: true, approval: governing ? { id: governing.id, status: governing.status, expires_at: governing.expires_at } : null };
}

/**
 * Close a queued run as executed — the same three-column write on both the
 * decided and the never-gated path, and idempotent on `status = 'pending'` so
 * it can follow `decide()`'s own close (which finds the run by
 * `metadata->>approval_id` and so misses a row whose metadata was scrubbed).
 *
 * `state` and `completed_at` alongside the legacy `status`. Writing
 * `status = 'executed'` while leaving `state` at the 'awaiting_approval' the
 * row was inserted with left the run describing two different things at once,
 * and left `completed_at` null forever: the Display's "Handled today" tile
 * filters `state = 'completed'` and the billing value card filters
 * `completed_at`, so a plan a parent had just approved and Bubaly had just
 * materialised showed up in neither. `approved_at` is when the person said
 * yes; it is not a completion time and nothing may read it as one.
 * One clock read: the yes and the finish are the same moment on this path.
 */
async function markRunExecuted(
  sb: DB, runId: string, familyId: string, userId: string, summary: string, applied: WriteBackKind[],
): Promise<{ data: { id: string }[] | null; error: PostgrestError | null }> {
  // `state` and `completed_at` alongside the legacy `status`: the Display's
  // "Handled today" tile filters `state = 'completed'` and the billing value
  // card filters `completed_at`, so a run stamped only `status = 'executed'`
  // showed up in neither. `approved_at` is when the person said yes, not a
  // completion time; on this path the yes and the finish are one clock read.
  const now = new Date().toISOString();
  // The rows it stamped come back so a caller can tell "stamped" from "no
  // longer pending". After decide() the second is expected (decide closes the
  // runs naming its approval); on the direct path it is the caller's to report.
  return sb.from('family_automation_runs').update({
    status: 'executed', state: 'completed', summary, result: { steps: applied } as never,
    approved_by: userId, approved_at: now, completed_at: now,
  }).eq('id', runId).eq('family_id', familyId).eq('status', 'pending').select('id');
}

/**
 * Approve a queued run (managers only): execute it and stamp both audits.
 *
 * WHY THIS DEFERS TO `decide()` WHEN AN APPROVAL ROW EXISTS. This button was a
 * second decision surface, and it knew none of the rules the first one
 * enforces. It checked `isManager` and then stamped the approval
 * `status = 'approved'` itself, without ever reading `approval_model`,
 * `required_approvals` or `approvals` — so a family that chose "Two parents" in
 * Trust & Permissions had their plan materialised (real calendar events and
 * reminders) by one adult's tap, while the SAME row on the approval card would
 * have answered "This one needs two parents to agree." The threshold, the
 * duplicate-vote check, the expiry check and the trust audit row all live in
 * `decide`; routing through it is what makes them one rule instead of two.
 *
 * WHY THE APPROVAL IS LOOKED UP AND NOT READ OFF THE RUN. See
 * `governingApprovalFor`: the run's metadata is a manager-writable cache of
 * the gate, and a cache is not a gate.
 *
 * A run whose plan has no approval row is a run the trust engine never gated
 * (the autopilot dial downgraded an `allow` to "ask"), so there is no
 * threshold to honour and the direct path below still applies.
 */
export async function executeQueuedRunAction(runId: string): Promise<LoopResult> {
  const t = await getTranslations();
  if (!runId) return { ok: false, error: t('actions.invalidRun') };
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsGuardiansCanApprove') };
  const sb = await createServer();
  const familyId = ctx.active.familyId;

  // A refused read left `run` null and answered "run not found or already
  // decided" — a claim about the run's state, from a read that never saw it.
  // Audit C1-S9-48.
  const { data: run, error: runReadErr } = await sb
    .from('family_automation_runs').select('id, status, metadata')
    .eq('id', runId).eq('family_id', familyId).maybeSingle();
  if (runReadErr) return { ok: false, error: describeActionError(runReadErr, t('actions.couldNotLoadThatRun')) };
  if (!run || run.status !== 'pending') return { ok: false, error: t('actions.runNotFoundOrAlready') };

  const meta = (run.metadata ?? {}) as RunMeta;
  if (!meta.plan_id) return { ok: false, error: t('actions.runHasNoPlanAttached') };

  // Read STRICTLY: a failed read is not "no approval". Answering it with the
  // direct path would be the very bypass this closes, with a friendlier face.
  const governing = await governingApprovalFor(sb, familyId, meta.plan_id);
  if (!governing.ok) {
    console.error('[concierge] could not read the approval behind a queued run', { runId, familyId, error: governing.error });
    return { ok: false, error: describeActionError(governing.error, t('actions.couldNotCheckRunApproval')) };
  }

  if (governing.approval) {
    if (governing.approval.status !== 'pending') {
      // Decided elsewhere (the card, the sweep, a cancel) while this line stayed
      // pending — the two disagree, and the decision wins. Dismiss clears it.
      return { ok: false, error: t('actions.runApprovalAlreadyDecided'), code: 'approval_already_decided' };
    }
    const decided = await decide(scopeFromUserContext(ctx, sb), governing.approval.id, 'approved');
    if (!decided.ok) return { ok: false, error: decided.error };
    if (decided.data.status !== 'approved') {
      // One vote of several. Nothing was materialised and the run stays
      // pending, so the next approver still finds it here.
      revalidatePath(PATH);
      return { ok: true, mode: 'ask', applied: [], summary: decided.data.summary };
    }
    // `decide` materialised the plan through the same `materializeConciergePlan`
    // this action uses and reports what THIS decision applied — not every kind
    // ever logged against the plan. It closed the run rows that still name
    // this approval in their metadata; THIS row is closed here as well, so a
    // run whose metadata was scrubbed does not sit on the panel as pending
    // after its plan has been done. Idempotent on `status = 'pending'`.
    const applied = decided.data.applied ?? [];
    const { error: closeErr } = await markRunExecuted(sb, runId, familyId, ctx.user.id, decided.data.summary, applied);
    if (closeErr) {
      console.error('[concierge] executed-run status update failed after decide', { runId, familyId, error: closeErr });
      return { ok: false, error: describeActionError(closeErr, t('actions.appliedThePlanButCould')) };
    }
    revalidatePath(PATH);
    return { ok: true, mode: 'auto', applied, summary: decided.data.summary };
  }

  if (meta.approval_id) {
    // The run claims a gate the database does not show for its plan. That is a
    // tampered or corrupted row, not a never-gated one; fail closed.
    console.error('[concierge] a queued run names an approval that does not govern its plan', { runId, familyId, approvalId: meta.approval_id, planId: meta.plan_id });
    return { ok: false, error: t('actions.runClaimsMissingApproval') };
  }

  const { data: plan, error: planReadErr } = await sb
    .from('concierge_plans')
    .select('id, title, description, location, planned_for, budget_cents')
    .eq('id', meta.plan_id).eq('family_id', familyId).maybeSingle();
  if (planReadErr) return { ok: false, error: describeActionError(planReadErr, t('actions.couldNotLoadThatPlan')) };
  if (!plan) return { ok: false, error: t('actions.planNoLongerExists') };

  const kinds = (meta.kinds?.length ? meta.kinds : VALID).filter((k) => VALID.includes(k));

  // Claim the run before applying anything, so an approval and a dismissal (two
  // parents, or two tabs) cannot both win. Without the claim the dismissal's
  // compare-and-set could land while the plan was being applied, leaving real
  // calendar events behind a run recorded as dismissed. Both columns move:
  // `state` is what Needs-you, the run views and the kiosk read (DATA-018).
  const approvedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await sb.from('family_automation_runs').update({
    status: 'approved', state: 'executing', approved_by: ctx.user.id, approved_at: approvedAt,
  }).eq('id', runId).eq('family_id', familyId).eq('status', 'pending').select('id').maybeSingle();
  if (claimErr) {
    console.error('[concierge] run claim failed', { runId, familyId, error: claimErr });
    return { ok: false, error: describeActionError(claimErr, t('actions.couldNotApproveThatRun')) };
  }
  if (!claimed) return { ok: false, error: t('actions.runNotFoundOrAlready') };
  // Hand the run back to the approval queue if it does not finish, so the
  // manager can retry: materializePlan is idempotent (it skips kinds already in
  // concierge_plan_actions), which is what makes a retry safe.
  // Best-effort and logged, not raised: the caller is already reporting the
  // failure that made it release. Zero rows means the claim was no longer this
  // action's (the run was decided elsewhere), which is not a release to retry.
  // The claim is all three of `status`, `state` and `approved_at`: pausing the
  // run keeps `status = 'approved'` and moves only `state`, and a pause made
  // while the plan was applying is a person's decision to keep.
  const release = async () => {
    const { data: released, error: releaseErr } = await sb.from('family_automation_runs').update({
      status: 'pending', state: 'awaiting_approval', approved_by: null, approved_at: null,
    }).eq('id', runId).eq('family_id', familyId).eq('status', 'approved').eq('state', 'executing')
      .eq('approved_at', approvedAt).select('id');
    if (releaseErr) console.error('[concierge] run release failed', { runId, familyId, error: releaseErr });
    else if (wroteNoRows(released)) console.error('[concierge] run release matched no rows; the claim was no longer held', { runId, familyId });
  };

  let outcome: MaterializeResult;
  try {
    outcome = await materializePlan(sb, familyId, ctx.user.id, plan, kinds);
  } catch (error) {
    await release();
    throw error;
  }
  const { applied, failed } = outcome;
  if (failed.length) {
    // Released to `pending`: stamping it executed would retire the one button
    // that retries, over a plan that did not land. Audit C1-S9-72.
    console.error('[concierge] queued run materialization incomplete; released to pending', { runId, familyId, applied, failed });
    await release();
    revalidatePath(PATH);
    return { ok: false, error: t('actions.couldNotFinishApplyingPlan') };
  }
  const summary = runSummary(plan.title, applied);

  // Record the run as executed — conditional on the claim above still holding,
  // so a run that was released or taken by another decision is not overwritten.
  // materializePlan is idempotent, so surfacing a failure here and releasing
  // the run lets the manager safely retry rather than leaving it stuck with the
  // plan already applied. Zero rows is the same case as an error: reporting
  // success over it is what would make a retry necessary and invisible.
  // `approved_at` stays the claim's: it is when the person said yes, and
  // `completed_at` is when the plan finished. The claim is matched the same way
  // `release` matches it, so a run paused during the apply, or claimed again
  // by a newer approval, is not stamped over by this one.
  const { data: stamped, error: runErr } = await sb.from('family_automation_runs').update({
    status: 'executed', state: 'completed', summary, result: { steps: applied } as never,
    completed_at: new Date().toISOString(),
  }).eq('id', runId).eq('family_id', familyId).eq('status', 'approved').eq('state', 'executing')
    .eq('approved_at', approvedAt).select('id');
  if (runErr) {
    console.error('[concierge] executed-run status update failed', { runId, familyId, error: runErr });
    await release();
    return { ok: false, error: describeActionError(runErr, t('actions.appliedThePlanButCould')) };
  }
  if (wroteNoRows(stamped)) {
    console.error('[concierge] executed-run status update matched no rows; the claim was lost', { runId, familyId });
    await release();
    return { ok: false, error: t('actions.appliedThePlanButCould') };
  }

  // No approval stamp here on purpose. This branch is only reached when NO
  // approval row names the plan, so there is no approval to decide; the one
  // that used to live here wrote `status = 'approved'` with no votes, which is
  // exactly the threshold bypass the block above closes. (C1-S9-60 had
  // confirmed that stamp for its log; with the stamp gone, the approval's own
  // write is `decide()`'s, in lib/services/approvals.)
  revalidatePath(PATH);
  return { ok: true, mode: 'auto', applied, summary };
}

/** Dismiss a queued run (managers only) — nothing executes. */
export async function dismissQueuedRunAction(runId: string): Promise<Result> {
  const t = await getTranslations();
  if (!runId) return { ok: false, error: t('actions.invalidRun') };
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsGuardiansCanDecline') };
  const sb = await createServer();

  const { data: run, error: runReadErr } = await sb
    .from('family_automation_runs').select('id, status, metadata')
    .eq('id', runId).eq('family_id', ctx.active.familyId).maybeSingle();
  if (runReadErr) return { ok: false, error: describeActionError(runReadErr, t('actions.couldNotLoadThatRun')) };
  if (!run || run.status !== 'pending') return { ok: false, error: t('actions.runNotFoundOrAlready') };

  // The decline half of the same rule as the approve half above. When the run
  // is gated by an approval that is still open, "Dismiss" is a "no" on that
  // approval, and it goes through `decide()` exactly as the approval card's
  // Decline does: the caller's own vote is recorded (0381 refuses any other
  // shape), the trust audit gets its decision row, and `decide` closes the run
  // rows that name it. Writing `status = 'rejected'` here directly skipped the
  // audit and was a second decision surface.
  //
  // The approval is resolved by the PLAN, not read off the run's metadata —
  // see `governingApprovalFor`. A run without a plan has nothing to resolve
  // and is only a line to clear.
  const meta = (run.metadata ?? {}) as RunMeta;
  let declinedHere = false;
  if (meta.plan_id) {
    const governing = await governingApprovalFor(sb, ctx.active.familyId, meta.plan_id);
    if (!governing.ok) {
      console.error('[concierge] could not read the approval behind a queued run', { runId, planId: meta.plan_id, error: governing.error });
      return { ok: false, error: describeActionError(governing.error, t('actions.couldNotDismissThatRun')) };
    }
    const approval = governing.approval;
    const stillOpen = approval?.status === 'pending'
      && !(approval.expires_at && Date.parse(approval.expires_at) < Date.now());
    if (approval && stillOpen) {
      const declined = await decide(scopeFromUserContext(ctx, sb), approval.id, 'rejected');
      if (!declined.ok) return { ok: false, error: declined.error };
      declinedHere = true;
      // `decide` closed the runs whose metadata names this approval; fall
      // through so THIS row is closed too when its metadata was scrubbed.
    }
    // Otherwise the approval is already closed — decided on the approval card,
    // expired by the sweep, or gone — so there is no decision left to make,
    // only a stale line in this panel. Clearing it below records nothing about
    // the approval, which is why it is safe to allow.
  }

  // `state` alongside the legacy `status`, for the same reason the approve path
  // writes both: a dismissed run left at 'awaiting_approval' stays on "Needs
  // you" (app/(app)/dashboard/needs-you/page.tsx reads `state`) forever.
  //
  // Compare-and-set on `status = 'pending'`. Between the read above and this
  // write, the approval card can approve the plan and `decide()` close the run
  // as executed; an unconditional write would relabel a plan that DID land as
  // dismissed. Zero rows is "someone else resolved it" — unless this call's own
  // decline did, through `decide()`'s close of the runs naming the approval.
  // This covers a close that has LANDED; a decide() still materialising when
  // this write lands finds the row dismissed, and without a lock shared by the
  // two paths that narrower window stays open.
  const { data: dismissed, error: dismissErr } = await sb.from('family_automation_runs')
    .update({ status: 'dismissed', state: 'cancelled' })
    .eq('id', runId).eq('family_id', ctx.active.familyId).eq('status', 'pending')
    .select('id');
  if (dismissErr) {
    console.error('[concierge] dismiss-run status update failed', { runId, familyId: ctx.active.familyId, error: dismissErr });
    return { ok: false, error: describeActionError(dismissErr, t('actions.couldNotDismissThatRun')) };
  }
  // A dismissal that matched nothing leaves the run queued while telling the
  // manager it is gone — and the next tick offers it to them again.
  if (!declinedHere && wroteNoRows(dismissed)) {
    return { ok: false, error: t('actions.runNotFoundOrAlready') };
  }

  revalidatePath(PATH);
  return { ok: true, applied: [] };
}

/**
 * The family-facing autopilot dial (managers only): writes ONE system trust
 * policy — AI × scheduling × automate — whose effect the loop obeys.
 * auto → allow · ask → require_approval · off → deny.
 */
export async function setConciergeAutopilotAction(level: AutopilotLevel): Promise<Result> {
  const t = await getTranslations();
  if (!['auto', 'ask', 'off'].includes(level)) return { ok: false, error: t('actions.invalidLevel') };
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsGuardiansCanChange') };
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const effect = dialEffect(level);

  // Update the live policy on its FILTER, then insert only if none existed.
  //
  // This used to read the policy first and branch on what came back, with the
  // read's error discarded. A PostgREST read RESOLVES with { data, error }, so a
  // refused read handed back `data: null` — indistinguishable from "no policy
  // yet" — and the else branch inserted a SECOND autopilot policy.
  //
  // Two rows change the answer, because both carry priority 10 and the engine
  // takes the highest-priority match (lib/trust/engine.ts). It also ratcheted:
  // once two rows exist, `.maybeSingle()` itself fails — postgrest-js returns
  // PGRST116 with `data: null` for more than one row — so every later save read
  // null again and inserted yet another policy. The dial could never take
  // effect again, and reported success every time.
  //
  // Updating on the FILTER rather than on an id read back removes the read that
  // could not tell "refused" from "absent". 0302_one_live_system_policy.sql is
  // the other half: it disables the duplicates already in the database and adds
  // a partial unique index, so at most one LIVE system policy per (family, name)
  // survives for this update to move. The filter matches that index — a
  // disabled loser is left alone rather than re-enabled into a violation.
  const { data: updated, error: updateError } = await sb.from('trust_policies')
    .update({ effect, enabled: true })
    .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME)
    .eq('is_system', true).eq('enabled', true)
    .select('id');
  if (updateError) {
    console.error('[concierge] autopilot policy update failed', { familyId, effect, error: updateError });
    return { ok: false, error: describeActionError(updateError, t('actions.couldNotUpdateThatPolicy')) };
  }

  if ((updated ?? []).length === 0) {
    const { error: insertError } = await sb.from('trust_policies').insert({
      family_id: familyId, name: AUTOPILOT_POLICY_NAME,
      description: 'Governs whether Bubaly executes accepted concierge plans on its own (allow), asks first (require_approval), or stays hands-off (deny).',
      domain: AUTOPILOT_DOMAIN, capability: AUTOPILOT_CAPABILITY,
      subject_kind: 'ai', effect, priority: 10, enabled: true, is_system: true,
      created_by: ctx.user.id,
    });
    // 0302 makes a live system policy unique per (family, name), so a racing
    // second submit loses with 23505 instead of creating a rival row. The
    // winner already carries a level the parent chose; re-apply ours over it
    // rather than reporting a failure for a dial that is about to be right.
    if (insertError?.code === '23505') {
      // Four equalities against a row the RACING request just wrote. If that
      // winner does not match all four, this matches nothing — and the parent
      // was told the dial moved. Same confirmation as the direct branch above.
      const { data: retried, error: retryError } = await sb.from('trust_policies')
        .update({ effect, enabled: true })
        .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME)
        .eq('is_system', true).eq('enabled', true)
        .select('id');
      if (retryError) {
        console.error('[concierge] autopilot policy insert-race update failed', { familyId, effect, error: retryError });
        return { ok: false, error: describeActionError(retryError, t('actions.couldNotUpdateThatPolicy')) };
      }
      if (!retried?.length) return { ok: false, error: t('actions.couldNotUpdateThatPolicy') };
    } else if (insertError) {
      console.error('[concierge] autopilot policy insert failed', { familyId, effect, error: insertError });
      return { ok: false, error: describeActionError(insertError, t('actions.couldNotUpdateThatPolicy')) };
    }
  }

  revalidatePath(PATH);
  return { ok: true, applied: [] };
}
