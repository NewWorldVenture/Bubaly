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
import { isManager } from '@/lib/constants/roles';
import {
  availableWriteBackKinds, reminderLeadAt, writeBackTitle, type WriteBackKind,
} from '@/lib/concierge/apply';
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
 * Shared materializer: create the real records for `kinds`, skipping anything
 * already applied (concierge_plan_actions is the idempotence ledger). Used by
 * both the manual buttons and the autonomous loop.
 */
async function materializePlan(
  sb: DB, familyId: string, userId: string, plan: PlanRow, kinds: WriteBackKind[],
): Promise<WriteBackKind[]> {
  const doable = new Set(availableWriteBackKinds(plan));
  const targets = kinds.filter((k) => doable.has(k));

  const { data: existing } = await sb
    .from('concierge_plan_actions')
    .select('action_kind')
    .eq('family_id', familyId)
    .eq('plan_id', plan.id);
  const already = new Set((existing ?? []).map((r) => r.action_kind));

  const applied: WriteBackKind[] = [];
  for (const kind of targets) {
    if (already.has(kind)) continue;
    try {
      let targetTable = '';
      let targetId: string | null = null;

      if (kind === 'calendar' && plan.planned_for) {
        const descParts = [plan.description, plan.location ? `Location: ${plan.location}` : null].filter(Boolean);
        const { data: ev } = await sb.from('calendar_events').insert({
          family_id: familyId, created_by: userId, title: plan.title,
          description: descParts.length ? descParts.join('\n') : null,
          location: plan.location, category: 'general',
          starts_at: new Date(`${plan.planned_for}T00:00:00.000Z`).toISOString(), all_day: true,
        }).select('id').single();
        targetTable = 'calendar_events'; targetId = ev?.id ?? null;
      } else if (kind === 'reminder' || kind === 'task') {
        const { data: rem } = await sb.from('family_reminders').insert({
          family_id: familyId, created_by: userId,
          title: writeBackTitle(kind, plan.title),
          notes: plan.description ?? null,
          kind: kind === 'task' ? 'task' : 'reminder',
          remind_at: reminderLeadAt(plan.planned_for),
          ai_suggested: true,
        }).select('id').single();
        targetTable = 'family_reminders'; targetId = rem?.id ?? null;
      } else {
        continue;
      }

      await sb.from('concierge_plan_actions').insert({
        family_id: familyId, plan_id: plan.id, action_kind: kind,
        target_table: targetTable, target_id: targetId,
        detail: writeBackTitle(kind, plan.title), created_by: userId,
      });
      applied.push(kind);
    } catch {
      /* one failed write-back shouldn't abort the rest */
    }
  }
  return applied;
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

  await sb.from('family_automation_runs').update({
    status: 'executed', summary, result: { steps: applied } as never,
    approved_by: ctx.user.id, approved_at: new Date().toISOString(),
  }).eq('id', runId).eq('family_id', familyId);

  if (meta.approval_id) {
    await sb.from('approval_requests').update({
      status: 'approved', decided_by: ctx.user.id, decided_at: new Date().toISOString(),
      executed_at: new Date().toISOString(), execution_result: summary,
    }).eq('id', meta.approval_id).eq('family_id', familyId);
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

  await sb.from('family_automation_runs').update({ status: 'dismissed' })
    .eq('id', runId).eq('family_id', ctx.active.familyId);

  const meta = (run.metadata ?? {}) as { approval_id?: string | null };
  if (meta.approval_id) {
    await sb.from('approval_requests').update({
      status: 'declined', decided_by: ctx.user.id, decided_at: new Date().toISOString(),
    }).eq('id', meta.approval_id).eq('family_id', ctx.active.familyId);
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
