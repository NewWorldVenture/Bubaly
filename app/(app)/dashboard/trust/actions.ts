'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { CAPABILITIES, TRUST_DOMAINS, type Capability } from '@/lib/trust/engine';
import { ledgerWriter } from '@/lib/trust/ledger';
import { APPROVAL_MODELS, thresholdFor } from '@/lib/approvals/threshold';
import type { Json } from '@/lib/database.types';
import { describeActionError } from '@/lib/supabase/errors';
import { scopeFromUserContext } from '@/lib/services/scope';
import { decide } from '@/lib/services/approvals';
import {
  acceptedPolicyName, policyCoversTool, policyProposalFromPayload, POLICY_SUGGESTION_KIND,
} from '@/lib/autopilot/policy-candidates';

type Result = { ok: boolean; error?: string };

// The fallback is a PARAMETER now, not a default. A default is evaluated in
// the function's own scope, where the request translator cannot be — the lift
// put `t(...)` there and tsc said `Cannot find name 't'`. Every call site
// names its own message, which is also the only way each one can say what
// actually failed.
function actionFailure(error: unknown, fallback: string): Result {
  console.error('[trust-action] failed:', error);
  return { ok: false, error: describeActionError(error, fallback) };
}

const EFFECTS = ['allow', 'deny', 'require_approval', 'auto_approve'] as const;

const SUBJECT_KINDS = ['role', 'member', 'ai', 'everyone'] as const;

async function managerCtx() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ctx: null, error: t('actions.onlyAParentOrAdult') };
  return { ctx, error: null };
}

function isDomain(d: string) { return d === 'all' || (TRUST_DOMAINS as readonly string[]).includes(d); }
function isCapability(c: string) { return c === 'all' || (CAPABILITIES as readonly string[]).includes(c); }

// ─── Policies ────────────────────────────────────────────────────────────────
export async function savePolicyAction(input: {
  id?: string;
  name: string;
  description?: string;
  domain: string;
  capability: string;
  subjectKind: string;
  subjectRole?: string | null;
  subjectMemberId?: string | null;
  effect: string;
  conditions?: Record<string, unknown>;
  approvalModel?: string;
  requiredApprovals?: number;
  priority?: number;
  enabled?: boolean;
}): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };

  const name = input.name.trim();
  if (!name) return { ok: false, error: t('actions.giveThePolicyAName') };
  if (!isDomain(input.domain)) return { ok: false, error: t('actions.unknownDomain') };
  if (!isCapability(input.capability)) return { ok: false, error: t('actions.unknownCapability') };
  if (!(EFFECTS as readonly string[]).includes(input.effect)) return { ok: false, error: t('actions.unknownEffect') };
  if (!(SUBJECT_KINDS as readonly string[]).includes(input.subjectKind)) return { ok: false, error: t('actions.unknownSubject') };
  const model = input.approvalModel && (APPROVAL_MODELS as readonly string[]).includes(input.approvalModel) ? input.approvalModel : 'single';
  // The model IS the rule (lib/approvals/threshold.ts). Storing a count that
  // disagrees with it is how "Two-parent" came to approve on one vote, so the
  // count is derived from the model and the manager's number only raises it.
  const requiredApprovals = thresholdFor(model, Math.min(Math.max(input.requiredApprovals ?? 1, 1), 5), 2).required;

  const supabase = await createServer();
  const base = {
    name,
    description: input.description?.trim() || null,
    domain: input.domain,
    capability: input.capability,
    subject_kind: input.subjectKind,
    subject_role: input.subjectKind === 'role' ? (input.subjectRole ?? null) : null,
    subject_member_id: input.subjectKind === 'member' ? (input.subjectMemberId ?? null) : null,
    effect: input.effect,
    conditions: (input.conditions ?? {}) as Json,
    approval_model: model,
    required_approvals: requiredApprovals,
    priority: Math.min(Math.max(input.priority ?? 100, 0), 1000),
    enabled: input.enabled ?? true,
  };

  if (input.id) {
    const { error: e } = await supabase.from('trust_policies').update(base).eq('id', input.id).eq('family_id', ctx.active.familyId);
    if (e) return actionFailure(e, t('actions.couldNotUpdateThatPolicy'));
  } else {
    const { error: e } = await supabase.from('trust_policies').insert({ ...base, family_id: ctx.active.familyId, created_by: ctx.user.id });
    if (e) return actionFailure(e, t('actions.couldNotCreateThatPolicy'));
  }
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function togglePolicyAction(input: { id: string; enabled: boolean }): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const { error: e } = await supabase.from('trust_policies').update({ enabled: input.enabled }).eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (e) return actionFailure(e, t('actions.couldNotUpdateThatPolicy'));
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function deletePolicyAction(input: { id: string }): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const { error: e } = await supabase.from('trust_policies').delete().eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (e) return actionFailure(e, t('actions.couldNotDeleteThatPolicy'));
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

// ─── Learned policies (Household Autopilot, M7) ──────────────────────────────
/**
 * Above the concierge dial (10) and the form's default (100): a per-tool yes
 * the family gave on the strength of its own approval history is a more
 * specific decision than a general "ask first", and the engine picks the
 * highest priority among matching policies.
 */
const ACCEPTED_POLICY_PRIORITY = 200;

/**
 * Accept an Autopilot `policy` suggestion: write ONE narrow `trust_policies`
 * row — AI × the suggestion's domain × capability, effect allow, scoped by
 * `conditions.tags` to the single tool the family kept approving — and mark
 * the suggestion executed.
 *
 * Manager-only, through the same `savePolicyAction` the Trust form uses, so
 * the domain, capability and effect are validated exactly once and in one
 * place. A retry after the suggestion could not be marked done finds the
 * policy it already wrote rather than writing a second.
 */
export async function acceptPolicySuggestionAction(input: { suggestionId: string }): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const { data: suggestion, error: readError } = await supabase.from('autopilot_suggestions')
    .select('id, kind, status, payload')
    .eq('id', input.suggestionId).eq('family_id', familyId).maybeSingle();
  if (readError) return actionFailure(readError, t('actions.couldNotReadThatSuggestion'));
  if (!suggestion || suggestion.kind !== POLICY_SUGGESTION_KIND) return { ok: false, error: t('actions.thatSuggestionDoesNotProposeAPolicy') };
  if (suggestion.status !== 'open') return { ok: false, error: t('actions.thatSuggestionIsNoLongerOpen') };

  const proposal = policyProposalFromPayload(suggestion.payload);
  // Narrow by construction: a proposal that names no single domain, capability
  // or tool is not one this path will widen into a blanket.
  if (!proposal || proposal.domain === 'all' || proposal.capability === 'all' || !isDomain(proposal.domain) || !isCapability(proposal.capability)) {
    return { ok: false, error: t('actions.thatSuggestionDoesNotProposeAPolicy') };
  }

  const { data: held, error: heldError } = await supabase.from('trust_policies')
    .select('id, domain, capability, effect, enabled, conditions')
    .eq('family_id', familyId).in('subject_kind', ['ai', 'everyone']).eq('enabled', true).limit(200);
  if (heldError) return actionFailure(heldError, t('actions.couldNotCreateThatPolicy'));
  const alreadyHeld = (held ?? []).some((p) => policyCoversTool(p, proposal.domain, proposal.capability, proposal.tool));

  if (!alreadyHeld) {
    const saved = await savePolicyAction({
      name: acceptedPolicyName(proposal),
      description: proposal.evidence
        ? `Accepted from an Autopilot suggestion — ${proposal.evidence}.`
        : 'Accepted from an Autopilot suggestion.',
      domain: proposal.domain,
      capability: proposal.capability,
      subjectKind: 'ai',
      effect: 'allow',
      conditions: {
        tags: [proposal.tool],
        source: 'autopilot',
        suggestionId: suggestion.id,
        approvals: proposal.approvals,
        acceptedAt: new Date().toISOString(),
      },
      priority: ACCEPTED_POLICY_PRIORITY,
      enabled: true,
    });
    if (!saved.ok) return saved;
  }

  const { error: resolveError } = await supabase.from('autopilot_suggestions')
    .update({ status: 'executed', resolved_at: new Date().toISOString(), resolved_by: ctx.user.id })
    .eq('id', suggestion.id).eq('family_id', familyId);
  if (resolveError) return actionFailure(resolveError, t('actions.thePolicyWasSavedButTheSuggestion'));

  revalidatePath('/dashboard/trust');
  revalidatePath('/dashboard/autopilot');
  return { ok: true };
}

// ─── Permission grants ───────────────────────────────────────────────────────
export async function setPermissionGrantAction(input: {
  memberId: string; domain: string; capability: string; effect: 'allow' | 'deny' | 'clear';
}): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  if (!isDomain(input.domain) || input.domain === 'all') return { ok: false, error: t('actions.pickASpecificDomain') };
  if (!(CAPABILITIES as readonly string[]).includes(input.capability)) return { ok: false, error: t('actions.unknownCapability') };

  const supabase = await createServer();
  if (input.effect === 'clear') {
    const { error: e } = await supabase.from('permission_grants').delete()
      .eq('family_id', ctx.active.familyId).eq('member_id', input.memberId).eq('domain', input.domain).eq('capability', input.capability);
    if (e) return actionFailure(e, t('actions.couldNotClearThatPermission'));
  } else {
    const { error: e } = await supabase.from('permission_grants').upsert({
      family_id: ctx.active.familyId, member_id: input.memberId,
      domain: input.domain, capability: input.capability as Capability, effect: input.effect, created_by: ctx.user.id,
    }, { onConflict: 'family_id,member_id,domain,capability' });
    if (e) return actionFailure(e, t('actions.couldNotSaveThatPermission'));
  }
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

// ─── Delegations ─────────────────────────────────────────────────────────────
export async function createDelegationAction(input: {
  fromMemberId: string; toMemberId: string; domains: string[]; reason?: string; expiresAt: string;
}): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  if (input.fromMemberId === input.toMemberId) return { ok: false, error: t('actions.delegateToADifferentMember') };
  const expires = new Date(input.expiresAt);
  if (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) return { ok: false, error: t('actions.pickAFutureExpiry') };
  const domains = input.domains.filter(d => isDomain(d) && d !== 'all');

  const supabase = await createServer();
  const { error: e } = await supabase.from('trust_delegations').insert({
    family_id: ctx.active.familyId,
    from_member_id: input.fromMemberId, to_member_id: input.toMemberId,
    domains, reason: input.reason?.trim() || null,
    expires_at: expires.toISOString(), created_by: ctx.user.id,
  });
  if (e) return actionFailure(e, t('actions.couldNotCreateThatDelegation'));
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function revokeDelegationAction(input: { id: string }): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const { error: e } = await supabase.from('trust_delegations').update({ revoked_at: new Date().toISOString() })
    .eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (e) return actionFailure(e, t('actions.couldNotRevokeThatDelegation'));
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

// ─── Approval decisions ──────────────────────────────────────────────────────
/**
 * Kept for the surfaces that still import it; the decision itself lives in
 * `lib/services/approvals.decide`, which is the one place an approval turns
 * into work (tool call, released run steps, or concierge write-backs). The
 * manager check here is only the early, friendly refusal — the service and
 * 0251's RLS both enforce it again.
 */
export async function decideApprovalAction(input: { id: string; decision: 'approved' | 'rejected'; note?: string }): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentOrAdult2') };
  const scope = scopeFromUserContext(ctx, await createServer());
  const result = await decide(scope, input.id, input.decision, input.note ?? null);
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath('/dashboard/trust');
  revalidatePath('/home');
  revalidatePath('/dashboard');
  return { ok: true };
}

// ─── Emergency mode ──────────────────────────────────────────────────────────
export async function activateEmergencyAction(input: { kind: string; reason?: string; elevatedDomains: string[] }): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const kinds = ['medical', 'missing_person', 'severe_weather', 'natural_disaster', 'vehicle_accident', 'general'];
  const kind = kinds.includes(input.kind) ? input.kind : 'general';
  const domains = input.elevatedDomains.filter(d => isDomain(d));

  const supabase = await createServer();
  // Emergency elevation outranks every deny, policy and risk tier, so it must
  // name what it is elevating. Defaulting an empty selection to ['all'] turned
  // "I did not choose" into "everything, including money and medical".
  if (!domains.length) return { ok: false, error: t('actions.chooseWhichAreasTheEmergency') };

  const { error: e } = await supabase.from('emergency_sessions').insert({
    family_id: ctx.active.familyId, kind, reason: input.reason?.trim() || null,
    activated_by: ctx.active.member.id, elevated_domains: domains,
  });
  if (e) return actionFailure(e, t('actions.couldNotActivateEmergencyMode'));

  // 0260: the ledger is written by the server, not by the session that acted.
  await (await ledgerWriter(supabase)).from('trust_audit_logs').insert({
    family_id: ctx.active.familyId, actor_kind: 'member', actor_id: ctx.active.member.id,
    domain: 'emergency', capability: 'automate', decision: 'emergency_override',
    reason: `Emergency mode activated (${kind})${input.reason ? `: ${input.reason}` : ''}`,
  });
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function endEmergencyAction(input: { id: string }): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const { error: e } = await supabase.from('emergency_sessions')
    .update({ ended_at: new Date().toISOString(), ended_by: ctx.active.member.id })
    .eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (e) return actionFailure(e, t('actions.couldNotEndEmergencyMode'));
  revalidatePath('/dashboard/trust');
  return { ok: true };
}
