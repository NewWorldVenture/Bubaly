// ════════════════════════════════════════════════════════════════════════════
// Trust Engine — server bridge. Loads policies/grants/delegations/emergency from
// Supabase, runs the pure `evaluateAction`, records an explainable audit entry,
// and (when needed) opens an approval request. This is the single entry point
// every AI agent / privileged action should call before executing.
// ════════════════════════════════════════════════════════════════════════════
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
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
};

export type EvaluateOutcome = {
  decision: Decision;
  approvalId?: string;
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
}> {
  const nowIso = new Date().toISOString();
  const [{ data: policies }, { data: grants }, { data: dels }, { data: emergencies }] = await Promise.all([
    supabase.from('trust_policies').select('*').eq('family_id', familyId).eq('enabled', true),
    supabase.from('permission_grants').select('member_id, domain, capability, effect').eq('family_id', familyId),
    supabase.from('trust_delegations').select('to_member_id, domains, starts_at, expires_at, revoked_at')
      .eq('family_id', familyId).is('revoked_at', null).gt('expires_at', nowIso),
    supabase.from('emergency_sessions').select('elevated_domains').eq('family_id', familyId).is('ended_at', null),
  ]);

  const emergencyDomains = [...new Set((emergencies ?? []).flatMap((e: Record<string, unknown>) => (e.elevated_domains as string[]) ?? []))];

  return {
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
export async function evaluateTrust(supabase: DB, familyId: string, req: EvaluateRequest): Promise<EvaluateOutcome> {
  const inputs = await loadTrustInputs(supabase, familyId);
  const decision = evaluateAction({
    actor: req.actor, domain: req.domain, capability: req.capability, context: req.context,
    policies: inputs.policies, grants: inputs.grants, delegations: inputs.delegations,
    emergencyDomains: inputs.emergencyDomains,
  });

  let approvalId: string | undefined;
  if (decision.effect === 'require_approval' && (req.openApproval ?? true)) {
    const { data: appr } = await supabase.from('approval_requests').insert({
      family_id: familyId,
      domain: req.domain,
      capability: req.capability,
      requested_by_kind: req.actor.kind === 'ai_agent' ? 'ai' : 'member',
      requested_by_member_id: req.actor.kind === 'member' ? req.actor.id : null,
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
    approvalId = appr?.id;
  }

  // Explainable audit trail — always recorded.
  await supabase.from('trust_audit_logs').insert({
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

  return { decision, approvalId };
}

/** Resolve the trust role for a member row. */
export function roleOf(role: string | null | undefined): TrustRole {
  const r = (role ?? 'guest') as TrustRole;
  return (['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as TrustRole[]).includes(r) ? r : 'guest';
}
