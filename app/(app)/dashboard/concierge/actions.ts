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
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { availableWriteBackKinds, type WriteBackKind } from '@/lib/concierge/apply';
import { materializeConciergePlan } from '@/lib/services/approvals';
import {
  AUTOPILOT_AGENT, AUTOPILOT_CAPABILITY, AUTOPILOT_DOMAIN, AUTOPILOT_POLICY_NAME,
  approvalTitle, autonomyMode, dialEffect, isAcceptance, runSummary,
  type AutonomyMode, type AutopilotLevel,
} from '@/lib/autonomy/loop';
import { evaluateTrust, roleOf } from '@/lib/trust/server';

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
): Promise<WriteBackKind[]> {
  return materializeConciergePlan(sb, familyId, userId, plan, kinds);
}

/**
 * Manual apply — the existing "Make it happen" buttons. Unchanged behavior.
 */
export async function applyConciergePlanAction(planId: string, kinds: WriteBackKind[]): Promise<Result> {
  if (!planId) return { ok: false, error: 'Invalid plan' };
  const requested = kinds.filter((k): k is WriteBackKind => VALID.includes(k));
  if (requested.length === 0) return { ok: false, error: 'Nothing to apply' };

  const ctx = await requireUserContext();
  const sb = await createServer();

  const { data: plan } = await sb
    .from('concierge_plans')
    .select('id, title, description, location, planned_for, budget_cents')
    .eq('id', planId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();
  if (!plan) return { ok: false, error: 'Plan not found' };

  const applied = await materializePlan(sb, ctx.active.familyId, ctx.user.id, plan, requested);
  revalidatePath(PATH);
  return { ok: true, applied };
}

// ── The autonomous loop ──────────────────────────────────────────────────────

export type LoopResult =
  | { ok: true; mode: AutonomyMode; applied: WriteBackKind[]; summary: string | null }
  | { ok: false; error: string };

/**
 * Fired when a plan's status transitions into booked/confirmed. Consults the
 * trust engine and either executes now (audited run), queues for approval
 * (pending run + approval request), or does nothing (dial off / not an
 * acceptance transition).
 */
export async function planAcceptedAction(
  planId: string, prevStatus: string, nextStatus: string,
): Promise<LoopResult> {
  if (!planId) return { ok: false, error: 'Invalid plan' };
  if (!isAcceptance(prevStatus, nextStatus)) return { ok: true, mode: 'off', applied: [], summary: null };

  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;

  const { data: plan } = await sb
    .from('concierge_plans')
    .select('id, title, description, location, planned_for, budget_cents')
    .eq('id', planId)
    .eq('family_id', familyId)
    .maybeSingle();
  if (!plan) return { ok: false, error: 'Plan not found' };

  // Nothing new to do? Don't open approvals for a no-op.
  const kinds = availableWriteBackKinds(plan);
  const { data: existing } = await sb
    .from('concierge_plan_actions').select('action_kind')
    .eq('family_id', familyId).eq('plan_id', planId);
  const already = new Set((existing ?? []).map((r) => r.action_kind));
  const pendingKinds = kinds.filter((k) => !already.has(k));
  if (pendingKinds.length === 0) return { ok: true, mode: 'off', applied: [], summary: null };

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
  const mode = autonomyMode(decision);

  if (mode === 'auto') {
    const applied = await materializePlan(sb, familyId, ctx.user.id, plan, pendingKinds);
    const summary = runSummary(plan.title, applied);
    await sb.from('family_automation_runs').insert({
      family_id: familyId, trigger_type: 'plan_accepted', status: 'executed',
      summary, result: { steps: applied } as never,
      metadata: { plan_id: planId, basis: decision.basis, reason: decision.reason } as never,
      created_by: ctx.user.id,
    });
    revalidatePath(PATH);
    return { ok: true, mode, applied, summary };
  }

  if (mode === 'ask') {
    const summary = `Waiting for approval: ${approvalTitle(plan.title)}`;
    await sb.from('family_automation_runs').insert({
      family_id: familyId, trigger_type: 'plan_accepted', status: 'pending',
      summary,
      result: {} as never,
      metadata: {
        plan_id: planId, kinds: pendingKinds, approval_id: approvalId ?? null,
        basis: decision.basis, reason: decision.reason,
      } as never,
      created_by: ctx.user.id,
    });
    revalidatePath(PATH);
    return { ok: true, mode, applied: [], summary };
  }

  return { ok: true, mode: 'off', applied: [], summary: null };
}

/** Approve a queued run (managers only): execute it and stamp both audits. */
export async function executeQueuedRunAction(runId: string): Promise<LoopResult> {
  if (!runId) return { ok: false, error: 'Invalid run' };
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only parents/guardians can approve' };
  const sb = await createServer();
  const familyId = ctx.active.familyId;

  const { data: run } = await sb
    .from('family_automation_runs').select('id, status, metadata')
    .eq('id', runId).eq('family_id', familyId).maybeSingle();
  if (!run || run.status !== 'pending') return { ok: false, error: 'Run not found or already handled' };

  const meta = (run.metadata ?? {}) as { plan_id?: string; kinds?: WriteBackKind[]; approval_id?: string | null };
  if (!meta.plan_id) return { ok: false, error: 'Run has no plan attached' };

  const { data: plan } = await sb
    .from('concierge_plans')
    .select('id, title, description, location, planned_for, budget_cents')
    .eq('id', meta.plan_id).eq('family_id', familyId).maybeSingle();
  if (!plan) return { ok: false, error: 'Plan no longer exists' };

  const kinds = (meta.kinds?.length ? meta.kinds : VALID).filter((k) => VALID.includes(k));
  const applied = await materializePlan(sb, familyId, ctx.user.id, plan, kinds);
  const summary = runSummary(plan.title, applied);

  // Record the run as executed. materializePlan is idempotent (it skips kinds
  // already in concierge_plan_actions), so surfacing this failure lets the
  // manager safely retry rather than leaving the run stuck "pending" with the
  // plan already applied — which would look like the approval did nothing.
  const { error: runErr } = await sb.from('family_automation_runs').update({
    status: 'executed', summary, result: { steps: applied } as never,
    approved_by: ctx.user.id, approved_at: new Date().toISOString(),
  }).eq('id', runId).eq('family_id', familyId);
  if (runErr) {
    console.error('[concierge] executed-run status update failed', { runId, familyId, error: runErr });
    return { ok: false, error: describeActionError(runErr, 'Applied the plan but could not record the run as executed. Refresh and try again.') };
  }

  if (meta.approval_id) {
    const { error: apprErr } = await sb.from('approval_requests').update({
      // decided_by references family_members(id) (0093), not auth.users.
      status: 'approved', decided_by: ctx.active.member.id, decided_at: new Date().toISOString(),
      executed_at: new Date().toISOString(), execution_result: summary,
    }).eq('id', meta.approval_id).eq('family_id', familyId);
    if (apprErr) console.error('[concierge] approval stamp after execution failed', { approvalId: meta.approval_id, familyId, error: apprErr });
  }

  revalidatePath(PATH);
  return { ok: true, mode: 'auto', applied, summary };
}

/** Dismiss a queued run (managers only) — nothing executes. */
export async function dismissQueuedRunAction(runId: string): Promise<Result> {
  if (!runId) return { ok: false, error: 'Invalid run' };
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only parents/guardians can decline' };
  const sb = await createServer();

  const { data: run } = await sb
    .from('family_automation_runs').select('id, status, metadata')
    .eq('id', runId).eq('family_id', ctx.active.familyId).maybeSingle();
  if (!run || run.status !== 'pending') return { ok: false, error: 'Run not found or already handled' };

  const { error: dismissErr } = await sb.from('family_automation_runs').update({ status: 'dismissed' })
    .eq('id', runId).eq('family_id', ctx.active.familyId);
  if (dismissErr) {
    console.error('[concierge] dismiss-run status update failed', { runId, familyId: ctx.active.familyId, error: dismissErr });
    return { ok: false, error: describeActionError(dismissErr, 'Could not dismiss that run. Refresh and try again.') };
  }

  const meta = (run.metadata ?? {}) as { approval_id?: string | null };
  if (meta.approval_id) {
    const { error: apprErr } = await sb.from('approval_requests').update({
      // 0093's CHECK allows pending|approved|rejected|modified|expired|cancelled
      // and decided_by references family_members(id), not auth.users — the
      // previous 'declined' + user id never satisfied either, so this stamp had
      // always failed and only logged.
      status: 'rejected', decided_by: ctx.active.member.id, decided_at: new Date().toISOString(),
    }).eq('id', meta.approval_id).eq('family_id', ctx.active.familyId);
    if (apprErr) console.error('[concierge] approval decline stamp failed', { approvalId: meta.approval_id, familyId: ctx.active.familyId, error: apprErr });
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
  if (!['auto', 'ask', 'off'].includes(level)) return { ok: false, error: 'Invalid level' };
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only parents/guardians can change autopilot' };
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const effect = dialEffect(level);

  const { data: existing } = await sb
    .from('trust_policies').select('id')
    .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME).maybeSingle();

  if (existing?.id) {
    const { error } = await sb.from('trust_policies')
      .update({ effect, enabled: true })
      .eq('id', existing.id).eq('family_id', familyId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await sb.from('trust_policies').insert({
      family_id: familyId, name: AUTOPILOT_POLICY_NAME,
      description: 'Governs whether Bubaly executes accepted concierge plans on its own (allow), asks first (require_approval), or stays hands-off (deny).',
      domain: AUTOPILOT_DOMAIN, capability: AUTOPILOT_CAPABILITY,
      subject_kind: 'ai', effect, priority: 10, enabled: true, is_system: true,
      created_by: ctx.user.id,
    });
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(PATH);
  return { ok: true, applied: [] };
}
