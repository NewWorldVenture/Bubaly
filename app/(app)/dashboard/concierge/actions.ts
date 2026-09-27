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
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { availableWriteBackKinds, type WriteBackKind } from '@/lib/concierge/apply';
import { decide, materializeConciergePlan } from '@/lib/services/approvals';
import {
  AUTOPILOT_AGENT, AUTOPILOT_CAPABILITY, AUTOPILOT_DOMAIN, AUTOPILOT_POLICY_NAME,
  approvalTitle, autonomyMode, dialEffect, isAcceptance, runSummary,
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
): Promise<WriteBackKind[]> {
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

  const { data: plan } = await sb
    .from('concierge_plans')
    .select('id, title, description, location, planned_for, budget_cents')
    .eq('id', planId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();
  if (!plan) return { ok: false, error: t('actions.planNotFound') };

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
  const t = await getTranslations();
  if (!planId) return { ok: false, error: t('actions.invalidPlan') };
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
  if (!plan) return { ok: false, error: t('actions.planNotFound') };

  // Nothing new to do? Don't open approvals for a no-op.
  const kinds = availableWriteBackKinds(plan);
  const { data: existing } = await sb
    .from('concierge_plan_actions').select('action_kind')
    .eq('family_id', familyId).eq('plan_id', planId);
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
    const applied = await materializePlan(sb, familyId, ctx.user.id, plan, pendingKinds);
    const summary = runSummary(plan.title, applied);
    // Written by the server: 0252 only lets a member file their own unplanned
    // queued run, and this row records work Bubaly already did.
    // `completed_at` is not decoration: it is the only column the family's value
    // metric will count. lib/metric/completed-plans.ts filters the 7-day
    // headline on `completed_at`, and a row without one lands in the "excluded,
    // week unknown" bucket permanently — so the Finances card, the upgrade
    // paywall's value card and the Display's "Handled today" tile all read 0
    // for work Bubaly just did. The row records work already finished, so the
    // completion time is now.
    await createServiceClient().from('family_automation_runs').insert({
      family_id: familyId, trigger_type: 'plan_accepted', status: 'executed', state: 'completed',
      completed_at: new Date().toISOString(),
      requested_by_member_id: ctx.active.member.id,
      summary, result: { steps: applied } as never,
      metadata: { plan_id: planId, basis: decision.basis, reason: decision.reason } as never,
      created_by: ctx.user.id,
    });
    revalidatePath(PATH);
    return { ok: true, mode, applied, summary };
  }

  if (mode === 'ask') {
    const summary = `Waiting for approval: ${approvalTitle(plan.title)}`;
    await createServiceClient().from('family_automation_runs').insert({
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
    revalidatePath(PATH);
    return { ok: true, mode, applied: [], summary };
  }

  return { ok: true, mode: 'off', applied: [], summary: null };
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
 * A run with no `approval_id` is a run the trust engine never gated (the
 * autopilot dial downgraded an `allow` to "ask"), so there is no threshold to
 * honour and the direct path below still applies.
 */
export async function executeQueuedRunAction(runId: string): Promise<LoopResult> {
  const t = await getTranslations();
  if (!runId) return { ok: false, error: t('actions.invalidRun') };
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsGuardiansCanApprove') };
  const sb = await createServer();
  const familyId = ctx.active.familyId;

  const { data: run } = await sb
    .from('family_automation_runs').select('id, status, metadata')
    .eq('id', runId).eq('family_id', familyId).maybeSingle();
  if (!run || run.status !== 'pending') return { ok: false, error: t('actions.runNotFoundOrAlready') };

  const meta = (run.metadata ?? {}) as { plan_id?: string; kinds?: WriteBackKind[]; approval_id?: string | null };
  if (!meta.plan_id) return { ok: false, error: t('actions.runHasNoPlanAttached') };

  if (meta.approval_id) {
    const decided = await decide(scopeFromUserContext(ctx, sb), meta.approval_id, 'approved');
    if (!decided.ok) return { ok: false, error: decided.error };
    if (decided.data.status !== 'approved') {
      // One vote of several. Nothing was materialised and the run stays
      // pending, so the next approver still finds it here.
      revalidatePath(PATH);
      return { ok: true, mode: 'ask', applied: [], summary: decided.data.summary };
    }
    // `decide` materialised the plan through the same `materializeConciergePlan`
    // this action used, closed this run row on its `metadata->>approval_id`,
    // and reports what THIS decision applied — not every kind ever logged
    // against the plan.
    revalidatePath(PATH);
    return { ok: true, mode: 'auto', applied: decided.data.applied ?? [], summary: decided.data.summary };
  }

  const { data: plan } = await sb
    .from('concierge_plans')
    .select('id, title, description, location, planned_for, budget_cents')
    .eq('id', meta.plan_id).eq('family_id', familyId).maybeSingle();
  if (!plan) return { ok: false, error: t('actions.planNoLongerExists') };

  const kinds = (meta.kinds?.length ? meta.kinds : VALID).filter((k) => VALID.includes(k));

  // Claim the run before applying anything, so an approval and a dismissal (two
  // parents, or two tabs) cannot both win. Both columns move: `state` is what
  // Needs-you, the run views and the kiosk read, and writing `status` alone left
  // every decided run listed as awaiting approval for good (DATA-018).
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
  const release = async () => {
    const { error: releaseErr } = await sb.from('family_automation_runs').update({
      status: 'pending', state: 'awaiting_approval', approved_by: null, approved_at: null,
    }).eq('id', runId).eq('family_id', familyId).eq('status', 'approved').eq('approved_at', approvedAt);
    if (releaseErr) console.error('[concierge] run release failed', { runId, familyId, error: releaseErr });
  };

  let applied: WriteBackKind[];
  try {
    applied = await materializePlan(sb, familyId, ctx.user.id, plan, kinds);
  } catch (error) {
    await release();
    throw error;
  }
  const summary = runSummary(plan.title, applied);

  // Record the run as executed — conditional on the claim above still holding,
  // so a run that was released or taken by another decision is not overwritten.
  // materializePlan is idempotent (it skips kinds already in
  // concierge_plan_actions), so surfacing a failure here lets the manager safely
  // retry rather than leaving the run stuck with the plan already applied.
  //
  // `state` and `completed_at` alongside the legacy `status`. Writing
  // `status = 'executed'` while leaving `state` at the 'awaiting_approval' the
  // row was inserted with left the run describing two different things at once,
  // and left `completed_at` null forever: the Display's "Handled today" tile
  // filters `state = 'completed'` and the billing value card filters
  // `completed_at`, so a plan a parent had just approved and Bubaly had just
  // materialised showed up in neither. `approved_at` is when the person said
  // yes (stamped by the claim); it is not a completion time and nothing may
  // read it as one.
  const { data: executed, error: runErr } = await sb.from('family_automation_runs').update({
    status: 'executed', state: 'completed', summary, result: { steps: applied } as never,
    completed_at: new Date().toISOString(),
  }).eq('id', runId).eq('family_id', familyId).eq('status', 'approved').select('id').maybeSingle();
  if (runErr || !executed) {
    console.error('[concierge] executed-run status update failed', { runId, familyId, error: runErr ?? new Error('Run claim lost') });
    await release();
    return { ok: false, error: describeActionError(runErr, t('actions.appliedThePlanButCould')) };
  }

  // No approval stamp here on purpose. This branch is only reached when the run
  // carries NO `approval_id`, so there is no approval row to decide; the one
  // that used to live here wrote `status = 'approved'` with no votes, which is
  // exactly the threshold bypass the block above closes.
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

  const { data: run } = await sb
    .from('family_automation_runs').select('id, status, metadata')
    .eq('id', runId).eq('family_id', ctx.active.familyId).maybeSingle();
  if (!run || run.status !== 'pending') return { ok: false, error: t('actions.runNotFoundOrAlready') };

  // The decline half of the same rule as the approve half above. When the run
  // is gated by an approval that is still open, "Dismiss" is a "no" on that
  // approval, and it goes through `decide()` exactly as the approval card's
  // Decline does: the caller's own vote is recorded (0381 refuses any other
  // shape), the trust audit gets its decision row, and `decide` closes this run
  // on its `metadata->>approval_id`. Writing `status = 'rejected'` here directly
  // skipped the audit and was a second decision surface.
  const meta = (run.metadata ?? {}) as { approval_id?: string | null };
  if (meta.approval_id) {
    const { data: approval, error: approvalErr } = await sb
      .from('approval_requests').select('status, expires_at')
      .eq('id', meta.approval_id).eq('family_id', ctx.active.familyId).maybeSingle();
    if (approvalErr) {
      console.error('[concierge] could not read the approval behind a queued run', { runId, approvalId: meta.approval_id, error: approvalErr });
      return { ok: false, error: describeActionError(approvalErr, t('actions.couldNotDismissThatRun')) };
    }
    const stillOpen = approval?.status === 'pending'
      && !(approval.expires_at && Date.parse(approval.expires_at) < Date.now());
    if (stillOpen) {
      const declined = await decide(scopeFromUserContext(ctx, sb), meta.approval_id, 'rejected');
      if (!declined.ok) return { ok: false, error: declined.error };
      revalidatePath(PATH);
      return { ok: true, applied: [] };
    }
    // The approval is already closed — decided on the approval card, expired
    // by the sweep, or gone — so there is no decision left to make, only a
    // stale line in this panel. Clearing it below records nothing about the
    // approval, which is why it is safe to allow.
  }

  // `state` alongside the legacy `status`, for the same reason the approve path
  // writes both: a dismissed run left at 'awaiting_approval' stays on "Needs
  // you" (app/(app)/dashboard/needs-you/page.tsx reads `state`) forever. And
  // only a run still pending can be dismissed, so a dismissal cannot land on a
  // run an approval has already claimed.
  const { data: dismissed, error: dismissErr } = await sb.from('family_automation_runs')
    .update({ status: 'dismissed', state: 'cancelled' })
    .eq('id', runId).eq('family_id', ctx.active.familyId).eq('status', 'pending').select('id').maybeSingle();
  if (dismissErr) {
    console.error('[concierge] dismiss-run status update failed', { runId, familyId: ctx.active.familyId, error: dismissErr });
    return { ok: false, error: describeActionError(dismissErr, t('actions.couldNotDismissThatRun')) };
  }
  if (!dismissed) return { ok: false, error: t('actions.runNotFoundOrAlready') };

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
      const { error: retryError } = await sb.from('trust_policies')
        .update({ effect, enabled: true })
        .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME)
        .eq('is_system', true).eq('enabled', true);
      if (retryError) {
        console.error('[concierge] autopilot policy insert-race update failed', { familyId, effect, error: retryError });
        return { ok: false, error: describeActionError(retryError) };
      }
    } else if (insertError) {
      console.error('[concierge] autopilot policy insert failed', { familyId, effect, error: insertError });
      return { ok: false, error: describeActionError(insertError) };
    }
  }

  revalidatePath(PATH);
  return { ok: true, applied: [] };
}
