// ════════════════════════════════════════════════════════════════════════════
// Trust Engine — server bridge. Loads policies/grants/delegations/emergency from
// Supabase, runs the pure `evaluateAction`, records an explainable audit entry,
// and (when needed) opens an approval request. This is the single entry point
// every AI agent / privileged action should call before executing.
// ════════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import { settleAll } from '@/lib/supabase/settle';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { ledgerWriter } from '@/lib/trust/ledger';
import {
  evaluateAction, type Actor, type Capability, type Decision,
  type Policy, type Grant, type Delegation, type ActionContext, type TrustRole,
} from '@/lib/trust/engine';

type DB = SupabaseClient<Database>;

export type EvaluateRequest = {
  actor: Actor;
  domain: string;
  capability: Capability;
  context?: ActionContext;
  /** AI agent name, for audit + approval rows when actor.kind === 'ai_agent' */
  agent?: string;
  /** human-readable title for an approval request, if one is created */
  title?: string;
  summary?: string;
  /** action payload to persist so it can be executed on approval */
  payload?: Record<string, unknown>;
  /** create an approval_request row when the decision is require_approval (default true) */
  openApproval?: boolean;
  /**
   * `family_members.id` of the person an AGENT is acting for. Ignored when the
   * actor is the member themselves, because then the actor already is the asker.
   */
  onBehalfOfMemberId?: string | null;
};

export type EvaluateOutcome = {
  decision: Decision;
  approvalId?: string;
  /** the approval row was already waiting; this call did not file a new one */
  alreadyPending?: boolean;
};

/** Map a DB policy row → engine Policy. */
function toPolicy(r: Record<string, unknown>): Policy {
  return {
    id: String(r.id),
    domain: String(r.domain ?? 'all'),
    capability: (r.capability as Policy['capability']) ?? 'all',
    subjectKind: (r.subject_kind as Policy['subjectKind']) ?? 'everyone',
    subjectRole: (r.subject_role as string | null) ?? null,
    subjectMemberId: (r.subject_member_id as string | null) ?? null,
    effect: (r.effect as Policy['effect']) ?? 'require_approval',
    conditions: (r.conditions as Policy['conditions']) ?? {},
    approvalModel: (r.approval_model as Policy['approvalModel']) ?? 'single',
    requiredApprovals: Number(r.required_approvals ?? 1),
    priority: Number(r.priority ?? 100),
    enabled: Boolean(r.enabled),
  };
}

/** Load every input the engine needs for one family. */
export async function loadTrustInputs(supabase: DB, familyId: string): Promise<{
  policies: Policy[]; grants: Grant[]; delegations: Delegation[]; emergencyDomains: string[];
  /**
   * True when a read that could have produced a DENY did not come back.
   *
   * These four results were destructured for `data` alone and every `error` was
   * dropped, each falling back to `?? []`. A failed `trust_policies` read then
   * evaluated as "this family has no policies" and a failed `permission_grants`
   * read as "this member has no deny grant" — and those are steps 2 and 3 of
   * the engine, the two that produce an explicit deny. The engine fell through
   * to role defaults, which are more permissive by construction; that is why a
   * family writes a policy in the first place.
   *
   * `settleAll` exists precisely so a transport rejection arrives "in the shape
   * the page expects" and the caller's own error handling runs. This caller had
   * none, so the whole mechanism landed on the floor here.
   *
   * Delegations and emergency sessions are NOT counted: losing either removes
   * an elevation, which fails closed on its own.
   */
  degraded: boolean;
}> {
  const nowIso = new Date().toISOString();
  const [
    { data: policies, error: policiesError },
    { data: grants, error: grantsError },
    { data: dels },
    { data: emergencies },
  ] = await settleAll([
    // Ordered. lib/trust/engine.ts sorts by `priority` alone, and
    // Array.prototype.sort is stable, so with equal priorities the winner is
    // whichever row came back first — and a query with no ORDER BY does not
    // promise one. 0302 stops the specific case that made this reachable (two
    // live system policies with one name), but a family may still write two
    // hand-made policies at the same priority, and which of those governs
    // should not depend on a query plan. Newest first, id as the final
    // tiebreak, so the answer is the same on every read.
    supabase.from('trust_policies').select('*').eq('family_id', familyId).eq('enabled', true)
      .order('priority', { ascending: false }).order('updated_at', { ascending: false }).order('id'),
    supabase.from('permission_grants').select('member_id, domain, capability, effect').eq('family_id', familyId),
    supabase.from('trust_delegations').select('to_member_id, domains, starts_at, expires_at, revoked_at')
      .eq('family_id', familyId).is('revoked_at', null).gt('expires_at', nowIso),
    // 0260 gives every elevation an expiry. An emergency that nobody remembered
    // to end must stop elevating on its own — it outranks explicit denies, so
    // "still open" is not enough to keep applying it. Rows written before 0260
    // were backfilled from their activation time, so none are open-ended.
    supabase.from('emergency_sessions').select('elevated_domains').eq('family_id', familyId)
      .is('ended_at', null).gt('expires_at', nowIso),
  ]);

  const emergencyDomains = [...new Set((emergencies ?? []).flatMap((e: Record<string, unknown>) => (e.elevated_domains as string[]) ?? []))];

  if (policiesError || grantsError) {
    console.error('[trust] the rules could not be read; decisions will degrade to approval',
      { familyId, policies: policiesError?.message, grants: grantsError?.message });
  }

  return {
    degraded: Boolean(policiesError || grantsError),
    policies: (policies ?? []).map(toPolicy),
    grants: (grants ?? []).map((g: Record<string, unknown>) => ({
      memberId: String(g.member_id), domain: String(g.domain),
      capability: g.capability as Capability, effect: g.effect as 'allow' | 'deny',
    })),
    delegations: (dels ?? []).map((d: Record<string, unknown>) => ({
      toMemberId: String(d.to_member_id), domains: (d.domains as string[]) ?? [],
      startsAt: new Date(String(d.starts_at)).getTime(), expiresAt: new Date(String(d.expires_at)).getTime(),
      revoked: false,
    })),
    emergencyDomains,
  };
}

/**
 * Evaluate an action through the Trust Engine, record the decision, and open an
 * approval request when required. Never throws on a normal "deny" — callers
 * branch on `outcome.decision.effect`.
 */

/**
 * File the approval row a `require_approval` decision implies.
 *
 * Exported because a caller can reach `require_approval` by a route this
 * function did not decide — the chat wrapper applies the family's risk tier
 * over the engine's answer, and telling somebody "sent for approval" with
 * nothing in the inbox to approve is worse than not gating at all.
 */
/**
 * Stable JSON: object keys in a fixed order at every depth, so two payloads that
 * differ only in key order hash the same. `JSON.stringify` preserves insertion
 * order, and a resent tool call assembled by a different code path can easily
 * produce the same object with the keys in a different sequence.
 */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}

/**
 * What makes two approval requests the same ACTION: the same thing, asked for by
 * the same person, in the same family.
 *
 * The payload is included in full — a natural key (title, due date) cannot see
 * the assignee, so "give Emma and Jack each a chore due Friday" would collapse
 * two different chores into one. The decision reasoning, priority and title are
 * NOT included: they are how the engine described the request, not what was
 * asked, and letting them vary would let two identical asks through.
 */
export function approvalDedupeKey(familyId: string, req: EvaluateRequest): string {
  return createHash('sha256').update(stable({
    familyId,
    domain: req.domain,
    capability: req.capability,
    actorKind: req.actor.kind === 'ai_agent' ? 'ai' : 'member',
    // Who it is FOR, which for an agent is the asker rather than Bubaly.
    asker: req.actor.kind === 'member' ? req.actor.id : (req.onBehalfOfMemberId ?? null),
    agent: req.actor.kind === 'ai_agent' ? (req.agent ?? req.actor.id) : null,
    payload: req.payload ?? {},
  })).digest('hex');
}

export type OpenedApproval = {
  id: string;
  /**
   * True when this returned a row that was ALREADY waiting. The caller must say
   * so rather than narrating a fresh send: a resend that silently reports
   * "sent for approval" is how one intent becomes two cards in a parent's inbox.
   */
  alreadyPending: boolean;
};

export async function openApprovalRequest(
  supabase: DB,
  familyId: string,
  req: EvaluateRequest,
  decision: Decision,
): Promise<OpenedApproval | null> {
  const writer = await ledgerWriter(supabase);
  const dedupeKey = approvalDedupeKey(familyId, req);

  // A pending row for this exact ask already covers it. 0273's partial unique
  // index makes this a fast lookup and, more importantly, makes the check
  // correct under a race: two simultaneous resends both miss here, one insert
  // wins, and the loser is caught below rather than filing a second card.
  const existing = await writer.from('approval_requests')
    .select('id').eq('family_id', familyId).eq('dedupe_key', dedupeKey).eq('status', 'pending')
    .limit(1).maybeSingle();
  if (existing.data?.id) return { id: existing.data.id, alreadyPending: true };

  const { data: appr, error } = await writer.from('approval_requests').insert({
    dedupe_key: dedupeKey,
    family_id: familyId,
    domain: req.domain,
    capability: req.capability,
    requested_by_kind: req.actor.kind === 'ai_agent' ? 'ai' : 'member',
    // For a member the actor IS the asker. For an agent the actor is Bubaly, so
    // the asker has to be carried alongside — without it the row records that
    // "Bubaly asked" and loses the person it asked for, which is the whole
    // reason an approved action could only ever be replayed as the approver.
    requested_by_member_id: req.actor.kind === 'member' ? req.actor.id : (req.onBehalfOfMemberId ?? null),
    agent: req.actor.kind === 'ai_agent' ? (req.agent ?? req.actor.id) : null,
    title: req.title ?? `${req.capability} · ${req.domain}`,
    summary: req.summary ?? null,
    payload: (req.payload ?? {}) as Json,
    amount_cents: req.context?.amountCents ?? null,
    confidence: req.context?.confidence ?? null,
    policy_id: decision.policyId ?? null,
    reasoning: decision.reason,
    approval_model: decision.approvalModel ?? 'single',
    required_approvals: decision.requiredApprovals ?? 1,
    status: 'pending',
    priority: req.context?.amountCents && req.context.amountCents > 20000 ? 'high' : 'normal',
  }).select('id').single();

  if (appr?.id) return { id: appr.id, alreadyPending: false };

  // 23505: the index caught a concurrent resend between our lookup and this
  // insert. The row that won is the answer — returning null here would tell the
  // family "could not send for approval" about a card sitting in their inbox.
  if (error?.code === '23505') {
    const raced = await writer.from('approval_requests')
      .select('id').eq('family_id', familyId).eq('dedupe_key', dedupeKey).eq('status', 'pending')
      .limit(1).maybeSingle();
    if (raced.data?.id) return { id: raced.data.id, alreadyPending: true };
  }
  if (error) console.error('[trust] approval request insert failed', error);
  return null;
}

export async function evaluateTrust(supabase: DB, familyId: string, req: EvaluateRequest): Promise<EvaluateOutcome> {
  const inputs = await loadTrustInputs(supabase, familyId);
  // Approval requests and audit rows are Bubaly's own, not the caller's: 0252
  // pins what a member may file on approval_requests and 0260 removes member
  // INSERT on trust_audit_logs entirely, so both go through the service role.
  const writer = await ledgerWriter(supabase);
  const engineDecision = evaluateAction({
    actor: req.actor, domain: req.domain, capability: req.capability, context: req.context,
    policies: inputs.policies, grants: inputs.grants, delegations: inputs.delegations,
    emergencyDomains: inputs.emergencyDomains,
  });

  // The rules did not load, so this `allow` may only exist because the deny
  // that would have governed is missing. Ask a parent instead.
  //
  // Not a hard deny: the audit-write comment below is right that a bookkeeping
  // failure must not become an outage of the whole AI layer, and the same
  // applies here. But the asymmetry matters — an audit row EXPLAINS a decision,
  // whereas the policies ARE the decision, and proceeding without them is not
  // degrading gracefully, it is quietly answering a different question.
  // `require_approval` is the one outcome that neither invents permission nor
  // takes the feature away: a human can still say yes.
  //
  // A deny is left exactly as it is. Losing rules can only ever have made the
  // engine more permissive, so a deny reached without them is still a deny.
  //
  // An EMERGENCY allow is left alone. `evaluateAction` resolves emergency
  // elevation in step 1, before a policy or grant is read at all, so a failed
  // read cannot have produced it — and putting an approval in front of
  // Emergency Operations Mode is the one place where asking is worse than
  // acting.
  const decision: Decision = inputs.degraded && engineDecision.effect === 'allow'
    && engineDecision.basis !== 'emergency'
    ? {
      effect: 'require_approval',
      reason: 'Bubaly could not read this family’s permission rules, so it is asking rather than assuming.',
      basis: 'degraded',
    }
    : engineDecision;

  let approvalId: string | undefined;
  let alreadyPending = false;
  if (decision.effect === 'require_approval' && (req.openApproval ?? true)) {
    const opened = await openApprovalRequest(supabase, familyId, req, decision);
    approvalId = opened?.id;
    alreadyPending = opened?.alreadyPending ?? false;
  }

  // Explainable audit trail. It said "always recorded" and was not: the insert
  // RESOLVES with { data, error } rather than throwing and the result was
  // discarded, so a refused write left no row and told nobody.
  //
  // This table is not incidental telemetry — it is the evidence base for the one
  // screen whose job is showing a family what Bubaly decided and why.
  // dashboard/trust reads the last forty rows (actor, domain, capability,
  // decision, reason, policy), and app/api/privacy/export states that every
  // download is a row here. A lost row is a decision the family cannot see,
  // including a denial or one that needed their approval.
  //
  // Deliberately NOT fatal. The approval request above is already open and its
  // own write was checked; callers act on the returned decision. Refusing a
  // decision because its explanation failed to log would turn a bookkeeping
  // failure into an outage of the whole AI layer, denials included. Loud is the
  // fix here; fatal is not.
  const { error: auditError } = await writer.from('trust_audit_logs').insert({
    family_id: familyId,
    actor_kind: req.actor.kind === 'ai_agent' ? 'ai_agent' : 'member',
    actor_id: req.actor.id,
    domain: req.domain,
    capability: req.capability,
    decision: decision.effect,
    reason: decision.reason,
    policy_id: decision.policyId ?? null,
    confidence: req.context?.confidence ?? null,
    approval_id: approvalId ?? null,
    context: { basis: decision.basis, amountCents: req.context?.amountCents ?? null },
  });
  if (auditError) {
    console.error('[trust] decision was made but not recorded',
      { familyId, domain: req.domain, capability: req.capability, decision: decision.effect }, auditError);
  }

  return { decision, approvalId, alreadyPending };
}

/** Resolve the trust role for a member row. */
export function roleOf(role: string | null | undefined): TrustRole {
  const r = (role ?? 'guest') as TrustRole;
  return (['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as TrustRole[]).includes(r) ? r : 'guest';
}
