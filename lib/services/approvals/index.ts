// The one place an approval turns into work.
//
// Before this module there were three: the trust inbox executed `{name,args}`
// payloads through the legacy action runner, the concierge page materialised
// accepted plans from a pending automation row, and the run executor waited
// for a step's approval to flip without anyone actually flipping it. Each fork
// had its own idea of who may decide, what "already decided" means and which
// audit row to write — and two of them disagreed about whether `decided_by`
// holds an auth user id or a `family_members.id` (0093 says the latter). Now
// `decide` and `editAndApprove` are the only writers of a decision, and the
// three payload kinds 0251 declares are the only shapes they know how to run:
//
//   'tool'            {name, args}              → executeTool with the trust
//                                                 gate skipped: the approval WAS
//                                                 the gate. If the approval was
//                                                 opened by a run step, the step
//                                                 is released instead and the
//                                                 executor performs the call
//                                                 under the run's idempotency
//                                                 key, so it can never run twice.
//   'plan_steps'      {run_id, step_ids, input} → the gated steps go back to
//                                                 `ready`, the run leaves
//                                                 `awaiting_approval`, and the
//                                                 executor is kicked.
//   'concierge_plan'  {plan_id, kinds}          → the concierge write-backs
//                                                 (calendar / reminder / prep
//                                                 task), through the same
//                                                 materialiser the manual
//                                                 "Make it happen" buttons use.
//
// WHY THE STATUS FLIP IS ONE CONDITIONAL UPDATE: two parents tapping Approve
// within the same second must not both execute. The update carries
// `status = 'pending'` in its WHERE clause and asks for the rows it touched;
// zero rows means someone else got there first, and that caller is told so
// before anything runs. No RPC exists for this yet (0251 documents the
// columns, not a function), so the guard lives here.
//
// WHY TWO CLIENTS: the decision itself is written with the caller's client so
// RLS (0251: managers decide, requesters may only cancel) is the enforcement
// boundary, not this file's role check. The run bookkeeping — steps, run row,
// timeline events — lives in tables 0250 gives members no write policy on, so
// those go through the service client exactly as `lib/ai/runs/controls.ts`
// does, with every statement still filtered by `family_id`.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { isManager, MANAGER_ROLES } from '@/lib/constants/roles';
import { thresholdFor, type Threshold } from '@/lib/approvals/threshold';
import { ledgerWriter } from '@/lib/trust/ledger';
import { executeTool } from '@/lib/ai/tools/execute';
import { markApprovedSchoolSource } from '@/lib/front-desk/school-approval';
import { getTool } from '@/lib/ai/tools/registry';
import { kickRun } from '@/lib/ai/runs/continue';
import { isTerminalRunState, legacyStatusFor, type RunState, type StepState } from '@/lib/ai/runs/states';
import {
  appendEvent, ledgerClient, loadPlanSteps, loadRun, updateRequest, updateRun, updateStep, type StepRow,
} from '@/lib/ai/runs/store';
import {
  availableWriteBackKinds, reminderLeadAt, writeBackTitle, type WriteBackKind,
} from '@/lib/concierge/apply';
import { runSummary } from '@/lib/autonomy/loop';
import {
  asRecord, classifyPayload, editableArgsOf, editableFieldsFor, toApprovalCardData, WRITE_BACK_KINDS,
  type ApprovalCardData, type ClassifiedPayload,
} from '@/lib/approvals/card-data';
import { aiApprovalReminders, type AiApprovalInput } from '@/lib/notifications/approval-reminders';
import { makeKey } from '@/lib/services/idempotency';
import { notify } from '@/lib/services/notifications';
import { scopeForSystem, scopeNow } from '@/lib/services/scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { settleAll } from '@/lib/supabase/settle';

type DB = SupabaseClient<Database>;
type ApprovalRow = Database['public']['Tables']['approval_requests']['Row'];

// ─── Public types ───────────────────────────────────────────────────────────
//
// The card shape and the payload classification are pure and shared with the
// client (`lib/approvals/card-data.ts`); they are re-exported here so the
// contract other modules code against — `import type { ApprovalCardData }
// from '@/lib/services/approvals'` — holds.
export type { ApprovalCardData, EditableField, ClassifiedPayload } from '@/lib/approvals/card-data';

export { classifyPayload, editableFieldsFor } from '@/lib/approvals/card-data';

export type DecideResult = { status: string; executed: boolean; resumedRunId: string | null; summary: string };
export type EditResult = { status: 'modified' | 'pending'; resumedRunId: string | null; summary?: string };

/** Card data for one row; `requestedBy` is resolved by the caller so this stays pure. */
export function toCardData(row: ApprovalRow, opts: { requestedBy: string | null; canEdit: boolean; managerCount?: number }): ApprovalCardData {
  return toApprovalCardData(row, opts);
}

// ─── Reads ──────────────────────────────────────────────────────────────────

const APPROVAL_COLUMNS = '*';

async function loadApproval(scope: ServiceScope, approvalId: string): Promise<ServiceResult<ApprovalRow | null>> {
  const { data, error } = await scope.db
    .from('approval_requests')
    .select(APPROVAL_COLUMNS)
    .eq('id', approvalId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) {
    console.error('[service:approvals] failed to read the approval', error);
    return fail(describeDbError(error, 'Bubaly could not read that approval.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok((data as ApprovalRow | null) ?? null);
}

/** Every pending approval for the family, newest first, as card data. */
export async function listPending(scope: ServiceScope): Promise<ServiceResult<ApprovalCardData[]>> {
  const { data, error } = await scope.db
    .from('approval_requests')
    .select(APPROVAL_COLUMNS)
    .eq('family_id', scope.familyId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) {
    console.error('[service:approvals] failed to list pending approvals', error);
    return fail(describeDbError(error, 'Bubaly could not load the approvals waiting on you.'), { code: SERVICE_CODES.db, retryable: true });
  }
  const rows = (data ?? []) as ApprovalRow[];

  const memberIds = [...new Set(rows.map((r) => r.requested_by_member_id).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (memberIds.length) {
    const { data: members, error: memberError } = await scope.db
      .from('family_members')
      .select('id, display_name')
      .eq('family_id', scope.familyId)
      .in('id', memberIds);
    if (memberError) {
      // A missing name is a cosmetic loss; a missing inbox is not.
      console.error('[service:approvals] failed to resolve requester names', memberError);
    }
    for (const m of members ?? []) names.set(m.id, m.display_name);
  }

  const canEdit = isManager(scope.role);
  // Only a consensus row's threshold depends on this, but the card must not
  // under-report one, so it is read once for the whole inbox.
  const { count: managerCount } = await scope.db
    .from('family_members')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', scope.familyId)
    .eq('is_active', true)
    .in('role', MANAGER_ROLES);
  return ok(rows.map((row) => toCardData(row, {
    // A parent deciding this needs to know who it is FOR. Bubaly filed it, but
    // it was somebody's request — and until the asker was recorded on the row
    // there was nothing to show, so every AI approval read simply "Bubaly".
    requestedBy: row.requested_by_kind === 'ai'
      ? (row.requested_by_member_id && names.get(row.requested_by_member_id)
        ? `Bubaly, for ${names.get(row.requested_by_member_id)}`
        : 'Bubaly')
      : (row.requested_by_member_id ? names.get(row.requested_by_member_id) ?? null : null),
    canEdit,
    managerCount: managerCount ?? 1,
  })));
}

// ─── Decision plumbing ──────────────────────────────────────────────────────

type Vote = { member_id: string; decision: 'approved' | 'rejected'; note: string | null; at: string; role?: string | null };

function priorVotes(row: ApprovalRow): Vote[] {
  return Array.isArray(row.approvals)
    ? (row.approvals as unknown[]).filter((v): v is Vote => !!asRecord(v) && typeof (v as Vote).member_id === 'string')
    : [];
}

async function auditDecision(
  scope: ServiceScope,
  row: ApprovalRow,
  decision: 'approved' | 'rejected' | 'modified' | 'approved_execution',
  reason: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  // 0260 removed member INSERT on trust_audit_logs: the record of who approved
  // what is evidence, so only the server writes it. Without service credentials
  // (unit tests) this falls back to the caller's client, unchanged.
  const writer = await ledgerWriter(scope.db);
  const { error } = await writer.from('trust_audit_logs').insert({
    family_id: scope.familyId,
    actor_kind: 'member',
    actor_id: scope.memberId,
    domain: row.domain,
    capability: row.capability,
    decision,
    reason,
    policy_id: row.policy_id ?? null,
    approval_id: row.id,
    context: { payload_kind: row.payload_kind ?? null, run_id: row.run_id ?? null, ...context } as Json,
  });
  // The decision already landed; a lost audit row must be visible in the logs
  // but must not roll a parent's "yes" back into "pending".
  if (error) console.error('[service:approvals] failed to write the decision audit row', error);
}

/**
 * The rule this row is under: how many approvals, and whether they must come
 * from parents. `approval_model` used to be decorative — the count was read and
 * the model never was, so "Two-parent" approved on one vote from any adult.
 *
 * Consensus needs to know how many people could vote, so the manager count is
 * read here rather than guessed.
 */
async function thresholdOf(scope: ServiceScope, row: ApprovalRow): Promise<Threshold> {
  const model = row.approval_model ?? 'single';
  if (model !== 'consensus') return thresholdFor(model, row.required_approvals, 1);
  const { count, error } = await scope.db
    .from('family_members')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', scope.familyId)
    .eq('is_active', true)
    .in('role', MANAGER_ROLES);
  if (error) {
    // Consensus that cannot count its household must not quietly become
    // "one yes"; fall back to the stricter of the stored count and two.
    console.error('[service:approvals] could not count managers for a consensus approval', error);
    return thresholdFor('consensus', Math.max(2, row.required_approvals ?? 2), 2);
  }
  return thresholdFor('consensus', row.required_approvals, count ?? 1);
}

/** "1 more parent needs" / "2 more people need" — the rule, said plainly. */
function whoStillNeeded(t: Threshold, remaining: number): string {
  if (t.parentsOnly) return remaining === 1 ? 'parent needs' : 'parents need';
  return remaining === 1 ? 'person needs' : 'people need';
}

/** Approvals that count toward the threshold — a rule may not accept every yes. */
function countingApprovals(votes: Vote[], t: Threshold): number {
  return votes.filter((v) => v.decision === 'approved' && (!t.parentsOnly || v.role === 'parent')).length;
}

/** Preconditions shared by both decision entry points. */
async function openForDecision(scope: ServiceScope, approvalId: string): Promise<ServiceResult<ApprovalRow>> {
  if (!isManager(scope.role)) return fail('Only a parent or adult in the family can decide approvals.', { code: SERVICE_CODES.denied });
  if (!scope.memberId) return fail('Bubaly could not tell who is deciding.', { code: SERVICE_CODES.denied });
  const loaded = await loadApproval(scope, approvalId);
  if (!loaded.ok) return loaded;
  const row = loaded.data;
  if (!row) return fail('That approval could not be found.', { code: SERVICE_CODES.notFound });
  if (row.status !== 'pending') return fail('This request was already decided.', { code: SERVICE_CODES.invalidInput });
  if (row.expires_at && Date.parse(row.expires_at) < scopeNow(scope).getTime()) {
    return fail('This request expired before anyone decided, so Bubaly will not act on it.', { code: SERVICE_CODES.invalidInput });
  }
  return ok(row);
}

/**
 * The atomic flip. Returns false when another decision won the race — the
 * `status = 'pending'` predicate is what makes a concurrent double-approve
 * touch zero rows for the loser.
 */
async function flipStatus(
  scope: ServiceScope,
  approvalId: string,
  patch: Database['public']['Tables']['approval_requests']['Update'],
): Promise<ServiceResult<boolean>> {
  const { data, error } = await scope.db
    .from('approval_requests')
    .update(patch)
    .eq('id', approvalId)
    .eq('family_id', scope.familyId)
    .eq('status', 'pending')
    .select('id');
  if (error) {
    console.error('[service:approvals] failed to record the decision', error);
    return fail(describeDbError(error, 'Bubaly could not record that decision.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok((data ?? []).length > 0);
}

async function stampExecution(scope: ServiceScope, approvalId: string, result: string): Promise<void> {
  const { error } = await scope.db
    .from('approval_requests')
    .update({ executed_at: new Date(scopeNow(scope).getTime()).toISOString(), execution_result: result.slice(0, 2000) })
    .eq('id', approvalId)
    .eq('family_id', scope.familyId);
  // The action already ran; if this stamp is lost the request looks
  // un-executed, so make the failure observable rather than silent.
  if (error) console.error('[service:approvals] execution-result stamp failed', { approvalId, error });
}

// ─── Run linkage ────────────────────────────────────────────────────────────

/**
 * The plan steps parked on this approval. Steps are looked up by their own
 * `approval_id` rather than trusted from the payload alone, because a
 * `{name,args}` approval opened by the tool gate inside a run carries no
 * `run_id` — the step that is waiting on it is the only record of the link.
 */
async function stepsWaitingOn(db: DB, familyId: string, approvalId: string, extraStepIds: string[]): Promise<ServiceResult<StepRow[]>> {
  const { data: byApproval, error } = await db
    .from('ai_plan_steps')
    .select('*')
    .eq('family_id', familyId)
    .eq('approval_id', approvalId);
  if (error) {
    console.error('[service:approvals] failed to find the steps waiting on an approval', error);
    return fail(describeDbError(error, 'Bubaly could not find the work this approval releases.'), { code: SERVICE_CODES.db, retryable: true });
  }
  const found = new Map<string, StepRow>((byApproval ?? []).map((s) => [s.id, s as StepRow]));
  const missing = extraStepIds.filter((id) => !found.has(id));
  if (missing.length) {
    const { data: byId, error: idError } = await db
      .from('ai_plan_steps')
      .select('*')
      .eq('family_id', familyId)
      .in('id', missing);
    if (idError) {
      console.error('[service:approvals] failed to read the approval steps', idError);
      return fail(describeDbError(idError, 'Bubaly could not find the work this approval releases.'), { code: SERVICE_CODES.db, retryable: true });
    }
    for (const s of byId ?? []) found.set(s.id, s as StepRow);
  }
  return ok([...found.values()]);
}

/** Step states that have produced nothing yet, so blocking or cancelling them loses no work. */
const UNSTARTED: readonly StepState[] = ['queued', 'ready', 'awaiting_approval', 'awaiting_context', 'planning'];

/** Every step downstream of `roots`, transitively, that has not started. */
function unstartedDependents(steps: readonly StepRow[], roots: readonly string[]): StepRow[] {
  const doomed = new Set(roots);
  const found = new Map<string, StepRow>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (doomed.has(step.id) || found.has(step.id)) continue;
      if (!UNSTARTED.includes(step.status as StepState)) continue;
      if (step.dependency_ids.some((id) => doomed.has(id))) {
        found.set(step.id, step);
        doomed.add(step.id);
        changed = true;
      }
    }
  }
  return [...found.values()];
}

/**
 * Fold a decision into the run that was waiting on it.
 *
 * Approved: the gated steps go back to `ready` with `approval_required` set,
 * so the executor's own gate re-reads the decision and calls the tool with
 * `skipTrust` — the approval was the gate — and under the run's step key, so
 * a duplicate row is impossible. Rejected: those steps are cancelled and their
 * unstarted dependents blocked, so the run finishes as `partially_completed`
 * or `failed` through `terminalRunStateFor` instead of hanging.
 *
 * The run is only returned to the queue from `awaiting_approval`/`blocked`. A
 * run that is `executing` reloads its steps every pass and picks the change up
 * itself; a `paused` run stays paused because a person asked for that.
 */
async function foldIntoRun(
  scope: ServiceScope,
  row: ApprovalRow,
  stepIds: string[],
  decision: 'approved' | 'rejected',
): Promise<ServiceResult<{ resumedRunId: string | null; runId: string | null; released: number }>> {
  const db = ledgerClient(scope);
  const waiting = await stepsWaitingOn(db, scope.familyId, row.id, stepIds);
  if (!waiting.ok) return waiting;
  const gated = waiting.data;
  if (gated.length === 0) return ok({ resumedRunId: null, runId: row.run_id, released: 0 });

  // The steps tell us which plan (and therefore which run) is involved even
  // when the approval row itself never recorded it.
  const planId = gated[0].plan_id;
  let runId = row.run_id;
  if (!runId) {
    const { data: runRow, error: runError } = await db
      .from('family_automation_runs')
      .select('id')
      .eq('family_id', scope.familyId)
      .eq('plan_id', planId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (runError) {
      console.error('[service:approvals] failed to find the run for an approval', runError);
      return fail(describeDbError(runError, 'Bubaly could not find the run this approval belongs to.'), { code: SERVICE_CODES.db, retryable: true });
    }
    runId = runRow?.id ?? null;
  }
  if (!runId) return fail('Bubaly could not find the run this approval belongs to.', { code: SERVICE_CODES.notFound });

  const run = await loadRun(scope, runId, { db });
  if (!run.ok) return run;
  if (!run.data) return fail('That run could not be found.', { code: SERVICE_CODES.notFound });
  const runState = run.data.state as RunState;
  const nowIso = scopeNow(scope).toISOString();

  if (decision === 'approved') {
    for (const step of gated) {
      if (step.status !== 'awaiting_approval' && step.status !== 'blocked') continue;
      const updated = await updateStep(scope, step.id, { status: 'ready', approval_required: true, approval_id: row.id, error: null }, { db });
      if (!updated.ok) return updated;
    }
  } else {
    const allSteps = await loadPlanSteps(scope, planId, { db });
    if (!allSteps.ok) return allSteps;
    for (const step of gated) {
      if (!UNSTARTED.includes(step.status as StepState)) continue;
      const updated = await updateStep(scope, step.id, {
        status: 'cancelled', error: 'Declined by a parent or adult.', completed_at: nowIso,
      }, { db });
      if (!updated.ok) return updated;
    }
    for (const dependent of unstartedDependents(allSteps.data, gated.map((s) => s.id))) {
      await updateStep(scope, dependent.id, { status: 'blocked', error: 'A step this one depends on was declined.' }, { db });
    }
  }

  const labels = gated.map((s) => s.description || s.tool_name || s.step_type);
  await appendEvent(scope, runId, {
    eventType: 'approval_decided',
    stepId: gated.length === 1 ? gated[0].id : null,
    message: decision === 'approved'
      ? `Approved: ${labels.join(', ')}.`
      : `Declined: ${labels.join(', ')} — Bubaly will not do ${gated.length === 1 ? 'it' : 'those'}.`,
    payload: { approval_id: row.id, status: decision, step_ids: gated.map((s) => s.id) },
  }, { db });

  // A finished or cancelled run is never re-opened by a late decision.
  if (isTerminalRunState(runState) || runState === 'paused') {
    return ok({ resumedRunId: null, runId, released: gated.length });
  }
  if (runState !== 'awaiting_approval' && runState !== 'blocked') {
    // Executing / ready / scheduled: the next pass reloads the steps.
    return ok({ resumedRunId: null, runId, released: gated.length });
  }

  const resumed = await updateRun(scope, runId, {
    state: 'ready',
    status: legacyStatusFor('ready'),
    run_after: nowIso,
    error: null,
    lease_owner: null,
    lease_expires_at: null,
  }, { db });
  if (!resumed.ok) return resumed;
  if (run.data.request_id) await updateRequest(scope, run.data.request_id, { status: 'ready', error: null }, { db });
  kickRun(runId);
  return ok({ resumedRunId: runId, runId, released: gated.length });
}

// ─── Concierge write-backs ──────────────────────────────────────────────────

export type ConciergePlanRow = {
  id: string; title: string; description: string | null; location: string | null;
  planned_for: string | null; budget_cents: number | null;
};

/**
 * Create the real records for an accepted concierge plan, skipping anything
 * `concierge_plan_actions` says already exists. This is the core the manual
 * "Make it happen" buttons and the approval path share; it lives here so the
 * insert logic exists once and a plan can never double-materialise because two
 * surfaces disagreed about what "already applied" means.
 */
export async function materializeConciergePlan(
  db: DB, familyId: string, userId: string, plan: ConciergePlanRow, kinds: WriteBackKind[],
): Promise<WriteBackKind[]> {
  const doable = new Set(availableWriteBackKinds(plan));
  const targets = kinds.filter((k) => doable.has(k));

  const { data: existing, error: existingError } = await db
    .from('concierge_plan_actions')
    .select('action_kind')
    .eq('family_id', familyId)
    .eq('plan_id', plan.id);
  if (existingError) {
    // Without the ledger there is no way to know what was already applied, and
    // guessing "nothing" is how a plan lands on the calendar twice.
    console.error('[concierge] could not read the write-back ledger', { planId: plan.id, familyId, error: existingError });
    return [];
  }
  const already = new Set((existing ?? []).map((r) => r.action_kind));

  const applied: WriteBackKind[] = [];
  for (const kind of targets) {
    if (already.has(kind)) continue;
    let targetTable = '';
    let targetId: string | null = null;

    if (kind === 'calendar' && plan.planned_for) {
      const descParts = [plan.description, plan.location ? `Location: ${plan.location}` : null].filter(Boolean);
      const { data: ev, error: evErr } = await db.from('calendar_events').insert({
        family_id: familyId, created_by: userId, title: plan.title,
        description: descParts.length ? descParts.join('\n') : null,
        location: plan.location, category: 'general',
        starts_at: new Date(`${plan.planned_for}T00:00:00.000Z`).toISOString(), all_day: true,
      }).select('id').single();
      // A failed insert is not "applied": claiming it would also skip it on the idempotent re-run.
      if (evErr) { console.error('[concierge] calendar write-back failed', { planId: plan.id, familyId, error: evErr }); continue; }
      targetTable = 'calendar_events'; targetId = ev?.id ?? null;
    } else if (kind === 'reminder' || kind === 'task') {
      const { data: rem, error: remErr } = await db.from('family_reminders').insert({
        family_id: familyId, created_by: userId,
        title: writeBackTitle(kind, plan.title),
        notes: plan.description ?? null,
        kind: kind === 'task' ? 'task' : 'reminder',
        remind_at: reminderLeadAt(plan.planned_for),
        ai_suggested: true,
      }).select('id').single();
      if (remErr) { console.error('[concierge] reminder write-back failed', { planId: plan.id, familyId, kind, error: remErr }); continue; }
      targetTable = 'family_reminders'; targetId = rem?.id ?? null;
    } else {
      continue;
    }

    const { error: logErr } = await db.from('concierge_plan_actions').insert({
      family_id: familyId, plan_id: plan.id, action_kind: kind,
      target_table: targetTable, target_id: targetId,
      detail: writeBackTitle(kind, plan.title), created_by: userId,
    });
    // The real record exists; a lost ledger row means a later re-run could
    // duplicate it, which is worth a log line but not worth un-counting the write.
    if (logErr) console.error('[concierge] concierge_plan_actions log failed', { planId: plan.id, familyId, kind, error: logErr });
    applied.push(kind);
  }
  return applied;
}

async function runConciergePlan(
  scope: ServiceScope,
  row: ApprovalRow,
  planId: string,
  kinds: WriteBackKind[],
): Promise<ServiceResult<{ summary: string; applied: WriteBackKind[] }>> {
  if (!scope.userId) return fail('Bubaly could not tell who is approving.', { code: SERVICE_CODES.denied });
  const { data: plan, error } = await scope.db
    .from('concierge_plans')
    .select('id, title, description, location, planned_for, budget_cents')
    .eq('id', planId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) {
    console.error('[service:approvals] failed to read the concierge plan', error);
    return fail(describeDbError(error, 'Bubaly could not read that plan.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!plan) return fail('That plan no longer exists.', { code: SERVICE_CODES.notFound });

  const applied = await materializeConciergePlan(scope.db, scope.familyId, scope.userId, plan, kinds);
  const summary = runSummary(plan.title, applied);

  // The concierge loop queued a legacy `pending` automation row beside this
  // approval; closing it here is what stops the Autopilot panel showing the
  // plan as waiting after a parent has already said yes.
  const { error: runError } = await scope.db
    .from('family_automation_runs')
    .update({
      status: 'executed', summary, result: { steps: applied } as unknown as Json,
      approved_by: scope.userId, approved_at: scopeNow(scope).toISOString(),
    })
    .eq('family_id', scope.familyId)
    .eq('status', 'pending')
    .filter('metadata->>approval_id', 'eq', row.id);
  if (runError) console.error('[service:approvals] could not close the concierge automation run', { approvalId: row.id, error: runError });

  return ok({ summary, applied });
}

async function dismissConciergeRun(scope: ServiceScope, row: ApprovalRow): Promise<void> {
  const { error } = await scope.db
    .from('family_automation_runs')
    .update({ status: 'dismissed' })
    .eq('family_id', scope.familyId)
    .eq('status', 'pending')
    .filter('metadata->>approval_id', 'eq', row.id);
  if (error) console.error('[service:approvals] could not dismiss the concierge automation run', { approvalId: row.id, error });
}

// ─── Execution after a decision ─────────────────────────────────────────────

/**
 * Turn an approved (or modified) row into work. `args` is the edited payload
 * when the Edit path is in play, otherwise the stored one.
 */
/**
 * The scope an APPROVED AI action should run under.
 *
 * `decideApproval` builds its scope from whoever is deciding, so replaying a
 * tool under it made Bubaly's work look like the approver's: a note the teen
 * asked for stamped `created_by` = the parent (and rendered on the activity page
 * as "Mum added note"), and — before that tool was pulled — an RSVP answering
 * for the parent and upserting over their own reply.
 *
 * Two things move, and only for rows BUBALY filed:
 *
 *   * `memberId`/`userId` become the ASKER's, so every `created_by` and
 *     member-scoped column names the person who wanted the thing. Safe under
 *     RLS: the database client stays the approver's session, and no table the
 *     AI writes carries a `created_by = auth.uid()` predicate (`0004` applies
 *     that only to `families` and `user_preferences`).
 *   * `actorKind` becomes `'ai'`, because it IS Bubaly doing the work — a human
 *     released it, they did not type it. That also restores the family activity
 *     line: `recordActivity` returns early for `actorKind === 'member'`, so
 *     until now NO approved write appeared in the feed at all.
 *
 * Confined to `requested_by_kind === 'ai'` — the same condition that already
 * decides `skipTrust`. A member-filed row keeps the decider's scope, because its
 * gate is re-evaluated under the approver's authority and re-labelling the actor
 * would change that evaluation.
 */
export async function scopeForApprovedWork(scope: ServiceScope, row: ApprovalRow): Promise<ServiceScope> {
  if (row.requested_by_kind !== 'ai') return scope;
  if (!row.requested_by_member_id) return unattributed(scope);

  const { data: asker, error } = await scope.db
    .from('family_members')
    .select('id, user_id')
    .eq('id', row.requested_by_member_id)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error || !asker) {
    if (error) console.error('[service:approvals] could not resolve the asker', error);
    return unattributed(scope);
  }
  return { ...scope, actorKind: 'ai', memberId: asker.id, userId: asker.user_id ?? scope.userId };
}

/**
 * An AI row whose asker cannot be resolved — a pre-existing row filed before the
 * asker was recorded, or a roster entry since removed.
 *
 * `memberId` is CLEARED rather than left as the approver's. A tool that does not
 * need it is unaffected; one that makes a first-person statement — an RSVP —
 * refuses, because its own guard is "Bubaly could not tell whose reply this is,
 * so it did not answer for anyone". Falling back to the decider would answer for
 * the wrong person and, on `event_rsvps_once`, upsert over their own reply.
 * Refusing something a parent approved is a bad outcome; recording it against
 * them is a worse one.
 */
function unattributed(scope: ServiceScope): ServiceScope {
  return { ...scope, actorKind: 'ai', memberId: null };
}

async function performApproved(
  scope: ServiceScope,
  row: ApprovalRow,
  classified: ClassifiedPayload,
  edited: Record<string, unknown> | null,
  decisionLabel: 'approved' | 'modified',
): Promise<ServiceResult<DecideResult>> {
  switch (classified.kind) {
    case 'plan_steps': {
      // Only a row Bubaly filed (server-side, requested_by_kind = 'ai') may name
      // extra steps to release. A member-filed row releases nothing beyond the
      // steps already pointing at it, so a forged {kind:'plan_steps'} payload
      // cannot un-block a parent's declined work.
      const releasable = row.requested_by_kind === 'ai' ? classified.stepIds : [];
      const folded = await foldIntoRun(scope, row, releasable, 'approved');
      if (!folded.ok) return folded;
      const summary = folded.data.released
        ? 'Approved — Bubaly is picking this up now.'
        : 'Approved. Those steps had already been handled.';
      await stampExecution(scope, row.id, summary);
      await auditDecision(scope, row, 'approved_execution', summary, { released: folded.data.released, resumed_run_id: folded.data.resumedRunId });
      return ok({ status: decisionLabel, executed: folded.data.released > 0, resumedRunId: folded.data.resumedRunId, summary });
    }

    case 'concierge_plan': {
      const kinds = edited
        ? WRITE_BACK_KINDS.filter((k) => edited[k] === true)
        : classified.kinds;
      const done = await runConciergePlan(scope, row, classified.planId, kinds);
      if (!done.ok) {
        await stampExecution(scope, row.id, `error: ${done.error}`);
        await auditDecision(scope, row, 'approved_execution', `Execution failed: ${done.error}`, { ok: false });
        return done;
      }
      await stampExecution(scope, row.id, done.data.summary);
      await auditDecision(scope, row, 'approved_execution', done.data.summary, { applied: done.data.applied });
      return ok({ status: decisionLabel, executed: done.data.applied.length > 0, resumedRunId: null, summary: done.data.summary });
    }

    case 'tool': {
      // A gate opened inside a run: the step, not this call, performs the tool
      // so the run's idempotency key and timeline stay the single record.
      const folded = await foldIntoRun(scope, row, [], 'approved');
      if (!folded.ok) return folded;
      if (folded.data.released > 0) {
        const summary = 'Approved — Bubaly is picking this up now.';
        await stampExecution(scope, row.id, summary);
        await auditDecision(scope, row, 'approved_execution', summary, { released: folded.data.released, resumed_run_id: folded.data.resumedRunId });
        return ok({ status: decisionLabel, executed: true, resumedRunId: folded.data.resumedRunId, summary });
      }

      const args = edited ?? classified.args;
      const actingScope = await scopeForApprovedWork(scope, row);
      const outcome = await executeTool(
        { ...actingScope, requestId: row.request_id ?? scope.requestId ?? null, runId: row.run_id ?? null },
        classified.name,
        args,
        {
          // The approval IS the gate — when Bubaly filed it. A row a member
          // filed themselves (requested_by_kind = 'member') is not a decision
          // Bubaly made, so the tool is evaluated again under the approver's
          // role rather than executed on the strength of the row's contents.
          skipTrust: row.requested_by_kind === 'ai',
          requestId: row.request_id ?? null,
          runId: row.run_id ?? null,
          // A retried decision (network blip after the flip) must not write twice.
          idempotencyKey: makeKey([scope.familyId, 'approval', row.id, classified.name]),
        },
      );

      if (outcome.status === 'ok') {
        const sourceHandled = await markApprovedSchoolSource(scope, row, outcome);
        await stampExecution(scope, row.id, outcome.summary);
        await auditDecision(scope, row, 'approved_execution', outcome.summary, { tool: classified.name, tool_call_id: outcome.toolCallId, verified: outcome.verified ?? null, ...(sourceHandled === null ? {} : { inbox_source_handled: sourceHandled }) });
        return ok({ status: decisionLabel, executed: true, resumedRunId: null, summary: outcome.summary });
      }
      const reason = outcome.status === 'denied'
        ? outcome.reason
        : outcome.status === 'pending_approval'
          ? 'Bubaly asked for approval again, which should not happen after a decision.'
          : outcome.error;
      await stampExecution(scope, row.id, `error: ${reason}`);
      await auditDecision(scope, row, 'approved_execution', `Execution failed: ${reason}`, { tool: classified.name, ok: false });
      return fail(`Approved, but Bubaly could not finish it: ${reason}`, {
        code: SERVICE_CODES.db, retryable: outcome.status === 'error' ? outcome.retryable : false,
      });
    }
  }
}

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Approve or decline a pending approval and, on approval, do the work.
 *
 * Multi-approver rows (`required_approvals > 1`) collect votes until the
 * threshold is met; every vote is audited, only the deciding one executes. A
 * rejection is final on the first vote — one "no" is enough to stop the AI.
 */
export async function decide(
  scope: ServiceScope,
  approvalId: string,
  decision: 'approved' | 'rejected',
  note?: string | null,
): Promise<ServiceResult<DecideResult>> {
  if (decision !== 'approved' && decision !== 'rejected') {
    return fail('A decision must be approved or rejected.', { code: SERVICE_CODES.invalidInput });
  }
  const opened = await openForDecision(scope, approvalId);
  if (!opened.ok) return opened;
  const row = opened.data;
  const memberId = scope.memberId as string;

  const prior = priorVotes(row);
  if (prior.some((v) => v.member_id === memberId)) {
    return fail('You already responded to this request.', { code: SERVICE_CODES.invalidInput });
  }
  const nowIso = scopeNow(scope).toISOString();
  const cleanNote = note?.trim() || null;
  const threshold = await thresholdOf(scope, row);
  // One "no" still stops the AI whoever says it — a rule about how many yeses
  // are needed is not a reason to ignore an objection. A yes that cannot count
  // is refused up front rather than recorded and quietly ignored.
  if (decision === 'approved' && threshold.parentsOnly && scope.role !== 'parent') {
    return fail('This one needs two parents to agree. Ask a parent to approve it.', { code: SERVICE_CODES.denied });
  }
  const votes: Vote[] = [...prior, { member_id: memberId, decision, note: cleanNote, at: nowIso, role: scope.role ?? null }];
  const approvedCount = countingApprovals(votes, threshold);
  const required = threshold.required;

  const finalStatus: 'pending' | 'approved' | 'rejected' =
    decision === 'rejected' ? 'rejected' : approvedCount >= required ? 'approved' : 'pending';

  const patch: Database['public']['Tables']['approval_requests']['Update'] = finalStatus === 'pending'
    ? { approvals: votes as unknown as Json, review_note: cleanNote ?? undefined }
    : {
      approvals: votes as unknown as Json,
      status: finalStatus,
      decided_by: memberId,
      decided_at: nowIso,
      reviewed_by: memberId,
      review_note: cleanNote,
    };
  const flipped = await flipStatus(scope, approvalId, patch);
  if (!flipped.ok) return flipped;
  if (!flipped.data) return fail('This request was already decided.', { code: SERVICE_CODES.invalidInput });

  await auditDecision(scope, row, decision, cleanNote ?? (
    finalStatus === 'pending'
      ? `Approval ${approvedCount} of ${required} recorded.`
      : `Approval ${decision}.`
  ), { votes: votes.length, required });

  if (finalStatus === 'pending') {
    const remaining = required - approvedCount;
    return ok({
      status: 'pending', executed: false, resumedRunId: null,
      summary: `Your approval is recorded — ${remaining} more ${whoStillNeeded(threshold, remaining)} to approve.`,
    });
  }

  const classified = classifyPayload(row);
  if (!classified) {
    const summary = 'Bubaly could not work out what this approval would do, so nothing was done.';
    await stampExecution(scope, approvalId, `error: ${summary}`);
    return fail(summary, { code: SERVICE_CODES.invalidInput });
  }

  if (finalStatus === 'rejected') {
    if (classified.kind === 'concierge_plan') {
      await dismissConciergeRun(scope, row);
    } else {
      const folded = await foldIntoRun(scope, row, classified.kind === 'plan_steps' ? classified.stepIds : [], 'rejected');
      // A declined approval must read as declined even if the run bookkeeping
      // fails; that failure is logged and the run's next pass reconciles it.
      if (!folded.ok) console.error('[service:approvals] could not fold a rejection into its run', folded.error);
    }
    return ok({ status: 'rejected', executed: false, resumedRunId: null, summary: 'Declined — Bubaly will not do that.' });
  }

  // The deciding vote must execute what the family agreed to. When an earlier
  // approver edited the request, `editAndApprove` recorded their change on
  // `edited_payload` and left the row pending — passing `null` here executed
  // the ORIGINAL instead, silently discarding the correction that was the whole
  // reason they engaged with it.
  return performApproved(scope, row, classified, storedEdit(row, classified), 'approved');
}

/**
 * The edit an earlier approver recorded, re-derived rather than trusted.
 *
 * `edited_payload` is a column, and `approval_requests_decide` lets any manager
 * write any column on a pending row. So the stored object is re-merged over the
 * original through the same allow-list `editAndApprove` uses and re-validated
 * against the tool's schema: an edit may only change fields the card offered,
 * and only to values the tool would have accepted at edit time. Anything else
 * falls back to the original, which is what the approvers were shown.
 */
function storedEdit(row: ApprovalRow, classified: ClassifiedPayload): Record<string, unknown> | null {
  const stored = asRecord(row.edited_payload);
  if (!stored) return null;

  const original = editableArgsOf(classified) ?? {};
  const allowed = new Set(editableFieldsFor(original).map((f) => f.key));
  const merged: Record<string, unknown> = { ...original };
  let changed = false;
  for (const [key, value] of Object.entries(stored)) {
    if (!allowed.has(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    if (merged[key] === value) continue;
    merged[key] = value;
    changed = true;
  }
  if (!changed) return null;

  if (classified.kind === 'tool') {
    const tool = getTool(classified.name);
    if (!tool || !tool.input.safeParse(merged).success) {
      console.error('[service:approvals] a stored edit no longer fits its tool; executing what was shown instead', { approval: row.id });
      return null;
    }
  }
  if (classified.kind === 'concierge_plan' && !WRITE_BACK_KINDS.some((k) => merged[k] === true)) return null;
  return merged;
}

/**
 * Change what an approval would do, then approve the changed version.
 *
 * The edits are merged over the stored arguments so a field the form did not
 * show is never dropped, validated against the tool's own schema where there
 * is one, and stored on `edited_payload` with status `modified` — the executor
 * (`lib/ai/runs/executor.ts`) reads that column as the step's replacement
 * input, so a plan step runs the edited version without a new plan.
 */
export async function editAndApprove(
  scope: ServiceScope,
  approvalId: string,
  editedPayload: unknown,
  note?: string | null,
): Promise<ServiceResult<EditResult>> {
  const edits = asRecord(editedPayload);
  if (!edits) return fail('The edited details must be an object of fields.', { code: SERVICE_CODES.invalidInput });

  const opened = await openForDecision(scope, approvalId);
  if (!opened.ok) return opened;
  const row = opened.data;
  const memberId = scope.memberId as string;

  const classified = classifyPayload(row);
  if (!classified) return fail('Bubaly could not work out what this approval would do, so it cannot be edited.', { code: SERVICE_CODES.invalidInput });

  const original = editableArgsOf(classified) ?? {};
  // Only the fields the card offered may change: an edit is a correction of
  // what was shown, never a way to smuggle in new arguments.
  const allowed = new Set(editableFieldsFor(original).map((f) => f.key));
  const merged: Record<string, unknown> = { ...original };
  for (const [key, value] of Object.entries(edits)) {
    if (!allowed.has(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    merged[key] = typeof value === 'string' ? value.trim() : value;
  }

  if (classified.kind === 'tool') {
    const tool = getTool(classified.name);
    if (!tool) return fail(`Bubaly no longer has a tool called "${classified.name}".`, { code: SERVICE_CODES.invalidInput });
    const parsed = tool.input.safeParse(merged);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      return fail(`Those edits do not fit — ${issues}.`, { code: SERVICE_CODES.invalidInput });
    }
  }
  if (classified.kind === 'concierge_plan' && !WRITE_BACK_KINDS.some((k) => merged[k] === true)) {
    return fail('Keep at least one thing for Bubaly to do, or decline instead.', { code: SERVICE_CODES.invalidInput });
  }

  const nowIso = scopeNow(scope).toISOString();
  const cleanNote = note?.trim() || null;
  const prior = priorVotes(row);
  if (prior.some((v) => v.member_id === memberId)) {
    return fail('You already responded to this request.', { code: SERVICE_CODES.invalidInput });
  }
  const threshold = await thresholdOf(scope, row);
  if (threshold.parentsOnly && scope.role !== 'parent') {
    return fail('This one needs two parents to agree. Ask a parent to approve it.', { code: SERVICE_CODES.denied });
  }
  const votes: Vote[] = [...prior, { member_id: memberId, decision: 'approved', note: cleanNote, at: nowIso, role: scope.role ?? null }];
  const changed = Object.keys(merged).filter((k) => merged[k] !== original[k]);

  // An edit is still one vote. A two-parent rule stays a two-parent rule:
  // record the edited payload and this approval, and wait for the rest.
  const approvedCount = countingApprovals(votes, threshold);
  const required = threshold.required;
  if (approvedCount < required) {
    const held = await flipStatus(scope, approvalId, {
      edited_payload: merged as Json,
      approvals: votes as unknown as Json,
      review_note: cleanNote ?? undefined,
    });
    if (!held.ok) return held;
    if (!held.data) return fail('This request was already decided.', { code: SERVICE_CODES.invalidInput });
    await auditDecision(scope, row, 'modified', cleanNote ?? `Edited ${changed.length ? changed.join(', ') : 'nothing'}; approval ${approvedCount} of ${required} recorded.`, { changed, votes: votes.length, required });
    const remaining = required - approvedCount;
    return ok({
      status: 'pending', resumedRunId: null,
      summary: `Your edits and approval are recorded — ${remaining} more ${whoStillNeeded(threshold, remaining)} to approve.`,
    });
  }

  const flipped = await flipStatus(scope, approvalId, {
    status: 'modified',
    edited_payload: merged as Json,
    approvals: votes as unknown as Json,
    decided_by: memberId,
    decided_at: nowIso,
    reviewed_by: memberId,
    review_note: cleanNote,
  });
  if (!flipped.ok) return flipped;
  if (!flipped.data) return fail('This request was already decided.', { code: SERVICE_CODES.invalidInput });

  await auditDecision(scope, row, 'modified', cleanNote ?? `Edited ${changed.length ? changed.join(', ') : 'nothing'} and approved.`, { changed });

  const done = await performApproved(scope, row, classified, merged, 'modified');
  if (!done.ok) return done;
  return ok({ status: 'modified', resumedRunId: done.data.resumedRunId });
}

// ─── Cron: expiry sweep ─────────────────────────────────────────────────────

const SWEEP_LIMIT = 500;

/**
 * Pending approvals past `expires_at` become `expired`, and a run parked on
 * one becomes `blocked` with a timeline event, so a family sees "this stopped
 * because nobody answered" instead of a run that looks alive forever.
 *
 * The initial read is necessarily cross-family (it is a sweep), but every
 * write is issued per family with an explicit `family_id`, per the cron rule.
 */
export async function expireStale(db: DB, now: Date = new Date()): Promise<{ expired: number; blockedRuns: number }> {
  const nowIso = now.toISOString();
  const { data, error } = await db
    .from('approval_requests')
    .select('id, family_id, run_id, plan_step_id, plan_step_ids, title')
    .eq('status', 'pending')
    .lt('expires_at', nowIso)
    .limit(SWEEP_LIMIT);
  if (error) {
    console.error('[service:approvals] expiry sweep read failed', error);
    return { expired: 0, blockedRuns: 0 };
  }
  const rows = data ?? [];
  if (rows.length === 0) return { expired: 0, blockedRuns: 0 };

  const byFamily = new Map<string, typeof rows>();
  for (const row of rows) byFamily.set(row.family_id, [...(byFamily.get(row.family_id) ?? []), row]);

  let expired = 0;
  let blockedRuns = 0;
  for (const [familyId, familyRows] of byFamily) {
    const { data: flipped, error: flipError } = await db
      .from('approval_requests')
      .update({ status: 'expired', decided_at: nowIso })
      .eq('family_id', familyId)
      .eq('status', 'pending')
      .in('id', familyRows.map((r) => r.id))
      .select('id');
    if (flipError) {
      console.error('[service:approvals] expiry sweep update failed', { familyId, error: flipError });
      continue;
    }
    const expiredIds = new Set((flipped ?? []).map((r) => r.id));
    expired += expiredIds.size;

    const scope = scopeForSystem(db, { id: familyId });
    for (const row of familyRows) {
      if (!expiredIds.has(row.id)) continue;
      const stepIds = [...new Set([...(row.plan_step_ids ?? []), ...(row.plan_step_id ? [row.plan_step_id] : [])])];
      const waiting = await stepsWaitingOn(db, familyId, row.id, stepIds);
      if (!waiting.ok) continue;
      const gated = waiting.data;
      for (const step of gated) {
        if (step.status !== 'awaiting_approval') continue;
        await updateStep(scope, step.id, { status: 'blocked', error: 'The approval expired before anyone decided.' }, { db });
      }

      const runId = row.run_id ?? (gated.length ? await runIdForPlan(db, familyId, gated[0].plan_id) : null);
      if (!runId) continue;
      const run = await loadRun(scope, runId, { db });
      if (!run.ok || !run.data || run.data.state !== 'awaiting_approval') continue;

      const message = `"${row.title}" expired before anyone approved it, so Bubaly stopped here.`;
      const blocked = await updateRun(scope, runId, {
        state: 'blocked', status: legacyStatusFor('blocked'), error: message, lease_owner: null, lease_expires_at: null,
      }, { db });
      if (!blocked.ok) continue;
      await appendEvent(scope, runId, { eventType: 'blocked', message, payload: { approval_id: row.id, reason: 'approval_expired' } }, { db });
      if (run.data.request_id) await updateRequest(scope, run.data.request_id, { status: 'blocked', error: message }, { db });
      blockedRuns += 1;
    }
  }
  return { expired, blockedRuns };
}

async function runIdForPlan(db: DB, familyId: string, planId: string): Promise<string | null> {
  const { data, error } = await db
    .from('family_automation_runs')
    .select('id')
    .eq('family_id', familyId)
    .eq('plan_id', planId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[service:approvals] could not find the run for a plan', { familyId, planId, error });
    return null;
  }
  return data?.id ?? null;
}

// ─── Cron: reminders ────────────────────────────────────────────────────────

/**
 * Tell each manager, once, about every AI approval waiting on them.
 *
 * "Once" is enforced twice over: the notify service refuses a second unread
 * row for the same `(type, related_id, user_id)`, and this sweep first checks
 * the dedupe key against every notification ever written for the family — so
 * a reminder the parent already read is not sent again on the next tick.
 */
export async function remindPendingApprovals(db: DB, now: Date = new Date()): Promise<{ reminded: number; families: number }> {
  const { data, error } = await db
    .from('approval_requests')
    .select('id, family_id, title, amount_cents, created_at, expires_at, agent')
    .eq('status', 'pending')
    .eq('requested_by_kind', 'ai')
    .or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`)
    .limit(SWEEP_LIMIT);
  if (error) {
    console.error('[service:approvals] reminder sweep read failed', error);
    return { reminded: 0, families: 0 };
  }
  const rows = data ?? [];
  if (rows.length === 0) return { reminded: 0, families: 0 };

  const byFamily = new Map<string, AiApprovalInput[]>();
  for (const row of rows) byFamily.set(row.family_id, [...(byFamily.get(row.family_id) ?? []), row]);

  let reminded = 0;
  let families = 0;
  for (const [familyId, approvals] of byFamily) {
    const [{ data: family, error: familyError }, { data: members, error: memberError }] = await settleAll([
      db.from('families').select('id, timezone').eq('id', familyId).maybeSingle(),
      db.from('family_members').select('id, user_id, role').eq('family_id', familyId).eq('is_active', true),
    ]);
    if (familyError || memberError) {
      console.error('[service:approvals] reminder sweep could not read the family', { familyId, error: familyError ?? memberError });
      continue;
    }
    const managers = (members ?? []).filter((m) => isManager(m.role)).map((m) => ({ id: m.id, user_id: m.user_id }));
    const candidates = aiApprovalReminders(approvals, managers, now);
    if (candidates.length === 0) continue;

    const { data: existing, error: existingError } = await db
      .from('notifications')
      .select('related_id')
      .eq('family_id', familyId)
      .eq('related_type', 'approval_requests')
      .in('related_id', candidates.map((c) => c.dedupe_key));
    if (existingError) {
      // Without the dedupe read every manager would be re-notified; skip the
      // family this tick rather than ship the duplicate.
      console.error('[service:approvals] reminder dedupe read failed', { familyId, error: existingError });
      continue;
    }
    const seen = new Set((existing ?? []).map((n) => n.related_id));

    const scope = scopeForSystem(db, { id: familyId, timezone: family?.timezone ?? null }, { now });
    let sent = 0;
    for (const c of candidates) {
      if (seen.has(c.dedupe_key)) continue;
      const res = await notify(scope, {
        recipients: [c.member_id],
        type: c.type,
        title: c.title,
        body: c.body,
        relatedType: c.related_type,
        relatedId: c.related_id,
      });
      if (!res.ok) {
        console.error('[service:approvals] approval reminder failed', { familyId, approvalId: c.approval_id, error: res.error });
        continue;
      }
      sent += res.data.created;
    }
    if (sent > 0) families += 1;
    reminded += sent;
  }
  return { reminded, families };
}
