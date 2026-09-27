'use server';
// lib/family/actions.ts
// Secure, server-side write paths for the Bubaly modules. Every action:
//   1. resolves the signed-in user + active family on the server (never trusts a
//      client-supplied family_id),
//   2. writes through the RLS-bound server client (is_family_member enforces
//      isolation as a hard boundary on top of this code),
//   3. only allows a whitelisted set of tables + columns (no arbitrary writes),
//   4. records an audit log entry.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { resolveFeatureEntitlement } from '@/lib/server/feature-entitlement';
import { isManager } from '@/lib/constants/roles';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { knowledgeGraphTarget, toCanonicalGraphRow } from '@/lib/twin/project';
import { logAudit } from '@/lib/server/audit';
import type { TrailAction } from '@/lib/activity/trail';
// lib reaching into app on purpose (m7r4): a queued concierge run must be decided
// by the Autopilot panel's own actions — one decision path, not a copy of it.
import { dismissQueuedRunAction, executeQueuedRunAction } from '@/app/(app)/dashboard/concierge/actions';

// Tables a member may write through these generic actions, with the columns
// each accepts. family_id / created_by / updated_by are always set server-side.
const WRITABLE: Record<string, string[]> = {
  family_routines: ['member_id', 'title', 'description', 'category', 'time_of_day', 'days_of_week', 'status'],
  family_digital_twin_profiles: ['member_id', 'strengths', 'notes', 'ai_insights', 'stress_baseline', 'preferences', 'responsibilities'],
  family_ai_recommendations: ['member_id', 'category', 'title', 'body', 'priority', 'cta_href', 'source', 'status'],
  family_stress_signals: ['member_id', 'signal_type', 'weight', 'source', 'occurred_on', 'notes'],
  family_automation_rules: ['name', 'trigger_type', 'trigger_config', 'action_type', 'action_config', 'is_enabled', 'requires_approval'],
  family_knowledge_nodes: ['member_id', 'node_type', 'label', 'ref_table', 'ref_id', 'weight'],
  family_knowledge_edges: ['source_id', 'target_id', 'relation', 'weight'],
  family_emergency_contacts: ['member_id', 'name', 'relationship', 'phone', 'alt_phone', 'email', 'address', 'is_primary', 'can_pickup', 'priority', 'notes'],
  family_emergency_plans: ['title', 'plan_type', 'content', 'safe_location', 'instructions', 'is_active'],
  family_memories: ['member_id', 'title', 'body', 'kind', 'memory_date', 'tags', 'is_favorite'],
  family_milestones: ['member_id', 'title', 'description', 'milestone_date', 'category'],
};

// The feature each whitelisted table belongs to. Writing one of these rows IS
// use of that feature, so the write is gated exactly as its page is — through
// the same resolver, so the two cannot drift.
//
// `family_ai_recommendations` and `family_milestones` are deliberately absent.
// Each is rendered by several pages that are not catalog features at all
// (`/dashboard/needs-you`, `/dashboard/planning`, `/dashboard/grandparent-portal`,
// `/home`), so there is no one feature a write to them belongs to. Guessing one
// would gate a surface nobody decided to gate, so they stay open and this says
// why.
const FEATURE_BY_TABLE: Record<string, string> = {
  family_routines:               '/dashboard/family-digital-twin',
  family_digital_twin_profiles:  '/dashboard/family-digital-twin',
  family_knowledge_nodes:        '/dashboard/family-digital-twin',
  family_knowledge_edges:        '/dashboard/family-digital-twin',
  family_stress_signals:         '/dashboard/family-stress',
  family_automation_rules:       '/dashboard/family-automation',
  family_emergency_contacts:     '/dashboard/family-emergency',
  family_emergency_plans:        '/dashboard/family-emergency',
  family_memories:               '/dashboard/memories',
};

// Sensitive surfaces only managers (parent/adult) may modify.
const MANAGER_ONLY = new Set([
  'family_automation_rules',
  'family_emergency_contacts',
  'family_emergency_plans',
  'family_digital_twin_profiles',
]);

/** `note` is a sentence the person should see even though nothing failed (one vote of several). */
export type ActionResult = { ok: true; id?: string; note?: string } | { ok: false; error: string };

/**
 * Refuses a write to a table whose feature this family does not have, and
 * answers `null` when the write may proceed.
 *
 * Applied to create and update, NOT to delete: a family that drops a tier keeps
 * the right to remove rows they made, and a gate on delete would strand their
 * own data behind an upgrade.
 *
 * The two refusals say different things on purpose. "Not part of your plan" is
 * a fact about the family; a failed plan read is a fact about Bubaly, and
 * reporting it as the first would tell a paying family to buy what they already
 * own because a database call blipped.
 */
async function refuseIfUnentitled(
  table: string,
  ctx: Awaited<ReturnType<typeof requireUserContext>>,
  supabase: Awaited<ReturnType<typeof createServer>>,
): Promise<ActionResult | null> {
  const href = FEATURE_BY_TABLE[table];
  if (!href || isSuperAdminEmail(ctx.user.email)) return null;
  try {
    const entitlement = await resolveFeatureEntitlement(supabase, ctx.active.familyId, href);
    if (entitlement.allowed) return null;
  } catch (error) {
    console.error('[family-action] plan read failed', error);
    return { ok: false, error: 'Bubaly could not confirm your plan right now. Try again in a moment.' };
  }
  return { ok: false, error: 'That is not part of your plan.' };
}

function actionFailure(operation: string, error: unknown): ActionResult {
  console.error(`[family-action] ${operation} failed:`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

function pick(table: string, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = WRITABLE[table];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (raw[key] !== undefined && raw[key] !== '') out[key] = raw[key];
  }
  return out;
}

// M3 — one graph, not two. The legacy `family_knowledge_nodes`/`_edges` tables
// (0022) are a second knowledge graph that nothing renders and that no reasoning
// surface reads; `graph_entities`/`graph_edges` (0129) is the canonical one that
// `loadFamilyContext` walks. A write aimed at the legacy tables is translated and
// landed in the canonical graph, stamped `provenance.source = 'manual'`, so a
// hand-made node is reasoned over like every other node — and is distinguishable
// from a projected one. The legacy tables are left untouched.
function graphWrite(table: string, values: Record<string, unknown>): { target: string; payload: Record<string, unknown> } {
  const target = knowledgeGraphTarget(table);
  if (!target) return { target: table, payload: pick(table, values) };
  return { target, payload: toCanonicalGraphRow(target, pick(table, values), new Date().toISOString()) };
}

export async function createFamilyRecord(
  table: string,
  values: Record<string, unknown>,
): Promise<ActionResult> {
  if (!(table in WRITABLE)) return { ok: false, error: 'Unknown record type.' };
  const ctx = await requireUserContext();
  if (MANAGER_ONLY.has(table) && !isManager(ctx.active.role)) {
    return { ok: false, error: 'Only parents and adults can change this.' };
  }
  const supabase = await createServer();
  const unentitled = await refuseIfUnentitled(table, ctx, supabase);
  if (unentitled) return unentitled;
  const { target, payload: mapped } = graphWrite(table, values);
  const payload: Record<string, unknown> = {
    ...mapped,
    family_id: ctx.active.familyId,
    created_by: ctx.user.id,
  };
  const writer = supabase.from(target as any) as any;
  // A canonical node that mirrors an existing row is unique on
  // (family_id, ref_table, ref_id) (0129), so a manual write naming a row the
  // projector already covers updates that node instead of failing on the index.
  const query = target === 'graph_entities' && payload.ref_table && payload.ref_id
    ? writer.upsert(payload, { onConflict: 'family_id,ref_table,ref_id' })
    : writer.insert(payload);
  const { data, error } = await query.select('id').single();
  if (error) return actionFailure('create that record', error);
  await logAudit(supabase, {
    familyId: ctx.active.familyId, actorId: ctx.user.id,
    action: 'create', resource: target, resourceId: data?.id ?? null,
  });
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id: data?.id };
}

export async function updateFamilyRecord(
  table: string,
  id: string,
  values: Record<string, unknown>,
): Promise<ActionResult> {
  if (!(table in WRITABLE)) return { ok: false, error: 'Unknown record type.' };
  const ctx = await requireUserContext();
  if (MANAGER_ONLY.has(table) && !isManager(ctx.active.role)) {
    return { ok: false, error: 'Only parents and adults can change this.' };
  }
  const supabase = await createServer();
  const unentitled = await refuseIfUnentitled(table, ctx, supabase);
  if (unentitled) return unentitled;
  const { target, payload: mapped } = graphWrite(table, values);
  // graph_entities / graph_edges have no `updated_by` column (0129); every other
  // whitelisted table does.
  const payload = target === table ? { ...mapped, updated_by: ctx.user.id } : mapped;
  // These two generic helpers back the write path for every whitelisted table,
  // so one missing confirmation here is the defect repeated across every surface
  // that uses them. Both return `{ ok: true, id }` — an assertion that the
  // record with THAT id changed — which a write matching zero rows could not
  // support. Audit C1-S9-55.
  const { data: updated, error } = await (supabase.from(target as any) as any)
    .update(payload).eq('id', id).eq('family_id', ctx.active.familyId).select('id');
  if (error) return actionFailure('update that record', error);
  if (wroteNoRows(updated as unknown[] | null)) return { ok: false, error: 'Could not update that record.' };
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id };
}

export async function deleteFamilyRecord(table: string, id: string): Promise<ActionResult> {
  if (!(table in WRITABLE)) return { ok: false, error: 'Unknown record type.' };
  const ctx = await requireUserContext();
  if (MANAGER_ONLY.has(table) && !isManager(ctx.active.role)) {
    return { ok: false, error: 'Only parents and adults can change this.' };
  }
  const supabase = await createServer();
  const target = knowledgeGraphTarget(table) ?? table;
  const { data: deleted, error } = await (supabase.from(target as any) as any)
    .delete().eq('id', id).eq('family_id', ctx.active.familyId).select('id');
  if (error) return actionFailure('delete that record', error);
  if (wroteNoRows(deleted as unknown[] | null)) return { ok: false, error: 'Could not delete that record.' };
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id };
}

/** Accept / dismiss / complete an AI recommendation. */
export async function setRecommendationStatus(
  id: string,
  status: 'accepted' | 'dismissed' | 'done',
): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data: recommended, error } = await supabase
    .from('family_ai_recommendations')
    .update({ status, updated_by: ctx.user.id })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId)
    .select('id');
  if (error) return actionFailure('update that recommendation', error);
  if (wroteNoRows(recommended)) return { ok: false, error: 'Could not update that recommendation.' };
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id };
}

/**
 * Approve or skip a pending autonomous automation run (manager-gated).
 *
 * WHY THIS IS NO LONGER A STATUS WRITE BY ID (m7r4). The Approve / Skip buttons
 * on /dashboard/family-automation and /dashboard/autonomous-family-management
 * are drawn for every run whose legacy `status` is 'pending', and two kinds of
 * row sit there with a vote standing between them and the family:
 *
 *   - a concierge plan the family's "ask first" dial queued
 *     (`metadata.plan_id`), gated by an `approval_requests` row that may say
 *     "Two parents";
 *   - a §10 run the executor parked on a step's approval
 *     (`state = 'awaiting_approval'`, the approval naming it by `run_id`).
 *
 * This action used to stamp `status = 'approved' | 'skipped'` plus
 * `approved_by`/`approved_at` on the row and read nothing else. Nothing
 * executes off that column (claim_ai_runs reads `state`), so no plan ran
 * without its vote — but the line left the queue as "approved" with nobody
 * having voted, the approval card stayed open on the other parent's screen,
 * a "Skip" was not a "no" (the plan still landed when the card was approved),
 * and when it did land `decide()` could not close the run, because it closes
 * only rows still at `status = 'pending'`: the run sat on "Needs you"
 * (which reads `state`) for good and never counted as handled.
 *
 * So the row's own gate decides what a tap means:
 *   - a run naming a concierge plan goes through the SAME decision path the
 *     Autopilot panel uses — executeQueuedRunAction / dismissQueuedRunAction,
 *     which resolve the governing approval from `approval_requests` (never
 *     from the run's manager-writable metadata) and route the vote through
 *     `decide()`, threshold and all. One rule, not a second surface;
 *   - a run a PENDING approval names by `run_id` is refused and pointed at the
 *     approval card, which is where that step's vote is taken. Its
 *     `state = 'awaiting_approval'` alone is not the gate: when the approval
 *     has closed but the run's state never advanced (a failed foldIntoRun,
 *     which the executor's next pass reconciles), Skip still clears the line,
 *     and Approve is refused — there is no open vote left to cast, and a
 *     stamped "approved" could contradict what the card decided;
 *   - only a run nothing governs keeps the direct write, compare-and-set on
 *     `status = 'pending'`.
 *
 * Every read here is strict: a failed read is not "no approval", and answering
 * it with the direct write would be the very bypass this closes.
 */
export async function resolveAutomationRun(
  id: string,
  decision: 'approved' | 'skipped',
): Promise<ActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) {
    // Was an English literal, on the refusal path of a manager-gated action —
    // the same half-translated shape found across eight modules: the path the
    // code was written for is translated and the path it falls back to is not.
    return { ok: false, error: t('actions.onlyParentsAndAdultsCanApprove') };
  }
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const { data: run, error: readError } = await supabase
    .from('family_automation_runs')
    .select('id, status, state, metadata')
    .eq('id', id)
    .eq('family_id', familyId)
    .maybeSingle();
  if (readError) {
    console.error('[family-action] could not read the automation run before resolving it', { id, familyId, error: readError });
    return { ok: false, error: describeActionError(readError, t('actions.couldNotCheckRunApproval')) };
  }
  if (!run || run.status !== 'pending') return { ok: false, error: t('actions.runNotFoundOrAlready') };

  // The trail row says what happened, not what was tapped: 'vote' when decide()
  // recorded this parent's yes and the approval is still open, 'approve' only
  // when the approval closed and the plan ran (or nothing gated the line).
  const audit = (action: TrailAction) => logAudit(supabase, {
    familyId, actorId: ctx.user.id, action,
    resource: 'family_automation_runs', resourceId: id,
  });

  // A concierge plan's run: the Autopilot panel's own decision path. The same
  // truthiness test those actions use, so no row that names a plan can fall
  // through to the direct write below.
  const meta = (run.metadata ?? {}) as { plan_id?: unknown };
  if (meta.plan_id) {
    if (decision === 'skipped') {
      const dismissed = await dismissQueuedRunAction(id);
      if (!dismissed.ok) return { ok: false, error: dismissed.error };
      await audit('skip');
      revalidatePath('/dashboard', 'layout');
      return { ok: true, id };
    }
    const res = await executeQueuedRunAction(id);
    if (!res.ok) {
      // The panel's sentence says "Dismiss"; this page's button says "Skip".
      return {
        ok: false,
        error: res.code === 'approval_already_decided' ? t('actions.runApprovalAlreadyDecidedSkip') : res.error,
      };
    }
    // `mode: 'ask'` is executeQueuedRunAction's answer for exactly one case:
    // decide() recorded this vote and the threshold is not met yet, so nothing
    // ran and the run stays pending. That — and only that — is worth a
    // sentence, or the tap looks like it did nothing. A completed execution
    // carries no note: the line leaves the list on refresh.
    const voteOnly = res.mode === 'ask';
    await audit(voteOnly ? 'vote' : 'approve');
    revalidatePath('/dashboard', 'layout');
    return voteOnly && res.summary ? { ok: true, id, note: res.summary } : { ok: true, id };
  }

  // A run the executor parked on a step's approval names it by `run_id`. While
  // that approval is open, its card is the decision; flipping this mirror
  // column would only hide the line. Read strictly — see above.
  const { data: gates, error: gateError } = await supabase
    .from('approval_requests')
    .select('id')
    .eq('family_id', familyId)
    .eq('run_id', id)
    .eq('status', 'pending')
    .limit(1);
  if (gateError) {
    console.error('[family-action] could not read the approval behind an automation run', { id, familyId, error: gateError });
    return { ok: false, error: describeActionError(gateError, t('actions.couldNotCheckRunApproval')) };
  }
  if (gates && gates.length > 0) return { ok: false, error: t('actions.runWaitsOnItsApproval') };

  // Parked on an approval that is no longer open — decided on its card,
  // expired, or cancelled — while the run's own state never advanced. There is
  // no vote left to cast, so Approve is refused; Skip falls through and clears
  // the line, as it always could.
  if (run.state === 'awaiting_approval' && decision === 'approved') {
    return { ok: false, error: t('actions.runApprovalAlreadyDecidedSkip') };
  }

  // Nothing governs this run (any more): the direct write, compare-and-set on
  // 'pending' so a run someone else just resolved is not resolved twice.
  // RLS FILTERS this update rather than refusing it. `logAudit` below records the
  // decision unconditionally, so a filtered write wrote an audit entry for an
  // approval that never happened — the log and the table disagreeing is worse
  // than either being wrong alone.
  const { data: resolved, error } = await supabase
    .from('family_automation_runs')
    .update({
      status: decision === 'approved' ? 'approved' : 'skipped',
      approved_by: ctx.user.id,
      approved_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .eq('family_id', ctx.active.familyId).select('id');
  if (error) return actionFailure('resolve that automation', error);
  // The same failure mode as the concierge autopilot in C1-S9-48: a manager
  // approves an automation, is told it worked, and the run stays pending — so
  // it is offered to them again, or the automation simply never executes.
  // Zero rows here also means someone else resolved it first (the CAS above).
  if (wroteNoRows(resolved)) return { ok: false, error: t('actions.runNotFoundOrAlready') };
  await audit(decision === 'approved' ? 'approve' : 'skip');
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id };
}
