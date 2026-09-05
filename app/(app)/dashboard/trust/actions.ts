'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { CAPABILITIES, TRUST_DOMAINS, type Capability } from '@/lib/trust/engine';
import type { Json } from '@/lib/database.types';
import { describeActionError } from '@/lib/supabase/errors';
import { scopeFromUserContext } from '@/lib/services/scope';
import { decide } from '@/lib/services/approvals';

type Result = { ok: boolean; error?: string };

function actionFailure(error: unknown, fallback = 'Could not update Trust Engine settings.'): Result {
  console.error('[trust-action] failed:', error);
  return { ok: false, error: describeActionError(error, fallback) };
}

const EFFECTS = ['allow', 'deny', 'require_approval', 'auto_approve'] as const;
const APPROVAL_MODELS = ['single', 'two_parent', 'first_available', 'consensus', 'sequential'] as const;
const SUBJECT_KINDS = ['role', 'member', 'ai', 'everyone'] as const;

async function managerCtx() {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ctx: null, error: 'Only a parent or adult can manage the Trust Engine.' as const };
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
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };

  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Give the policy a name.' };
  if (!isDomain(input.domain)) return { ok: false, error: 'Unknown domain.' };
  if (!isCapability(input.capability)) return { ok: false, error: 'Unknown capability.' };
  if (!(EFFECTS as readonly string[]).includes(input.effect)) return { ok: false, error: 'Unknown effect.' };
  if (!(SUBJECT_KINDS as readonly string[]).includes(input.subjectKind)) return { ok: false, error: 'Unknown subject.' };
  const model = input.approvalModel && (APPROVAL_MODELS as readonly string[]).includes(input.approvalModel) ? input.approvalModel : 'single';

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
    required_approvals: Math.min(Math.max(input.requiredApprovals ?? 1, 1), 5),
    priority: Math.min(Math.max(input.priority ?? 100, 0), 1000),
    enabled: input.enabled ?? true,
  };

  if (input.id) {
    const { error: e } = await supabase.from('trust_policies').update(base).eq('id', input.id).eq('family_id', ctx.active.familyId);
    if (e) return actionFailure(e, 'Could not update that policy.');
  } else {
    const { error: e } = await supabase.from('trust_policies').insert({ ...base, family_id: ctx.active.familyId, created_by: ctx.user.id });
    if (e) return actionFailure(e, 'Could not create that policy.');
  }
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function togglePolicyAction(input: { id: string; enabled: boolean }): Promise<Result> {
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const { error: e } = await supabase.from('trust_policies').update({ enabled: input.enabled }).eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (e) return actionFailure(e, 'Could not update that policy.');
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function deletePolicyAction(input: { id: string }): Promise<Result> {
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const { error: e } = await supabase.from('trust_policies').delete().eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (e) return actionFailure(e, 'Could not delete that policy.');
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

// ─── Permission grants ───────────────────────────────────────────────────────
export async function setPermissionGrantAction(input: {
  memberId: string; domain: string; capability: string; effect: 'allow' | 'deny' | 'clear';
}): Promise<Result> {
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  if (!isDomain(input.domain) || input.domain === 'all') return { ok: false, error: 'Pick a specific domain.' };
  if (!(CAPABILITIES as readonly string[]).includes(input.capability)) return { ok: false, error: 'Unknown capability.' };

  const supabase = await createServer();
  if (input.effect === 'clear') {
    const { error: e } = await supabase.from('permission_grants').delete()
      .eq('family_id', ctx.active.familyId).eq('member_id', input.memberId).eq('domain', input.domain).eq('capability', input.capability);
    if (e) return actionFailure(e, 'Could not clear that permission grant.');
  } else {
    const { error: e } = await supabase.from('permission_grants').upsert({
      family_id: ctx.active.familyId, member_id: input.memberId,
      domain: input.domain, capability: input.capability as Capability, effect: input.effect, created_by: ctx.user.id,
    }, { onConflict: 'family_id,member_id,domain,capability' });
    if (e) return actionFailure(e, 'Could not save that permission grant.');
  }
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

// ─── Delegations ─────────────────────────────────────────────────────────────
export async function createDelegationAction(input: {
  fromMemberId: string; toMemberId: string; domains: string[]; reason?: string; expiresAt: string;
}): Promise<Result> {
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  if (input.fromMemberId === input.toMemberId) return { ok: false, error: 'Delegate to a different member.' };
  const expires = new Date(input.expiresAt);
  if (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) return { ok: false, error: 'Pick a future expiry.' };
  const domains = input.domains.filter(d => isDomain(d) && d !== 'all');

  const supabase = await createServer();
  const { error: e } = await supabase.from('trust_delegations').insert({
    family_id: ctx.active.familyId,
    from_member_id: input.fromMemberId, to_member_id: input.toMemberId,
    domains, reason: input.reason?.trim() || null,
    expires_at: expires.toISOString(), created_by: ctx.user.id,
  });
  if (e) return actionFailure(e, 'Could not create that delegation.');
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function revokeDelegationAction(input: { id: string }): Promise<Result> {
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const { error: e } = await supabase.from('trust_delegations').update({ revoked_at: new Date().toISOString() })
    .eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (e) return actionFailure(e, 'Could not revoke that delegation.');
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
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent or adult can decide approvals.' };
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
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const kinds = ['medical', 'missing_person', 'severe_weather', 'natural_disaster', 'vehicle_accident', 'general'];
  const kind = kinds.includes(input.kind) ? input.kind : 'general';
  const domains = input.elevatedDomains.filter(d => isDomain(d));

  const supabase = await createServer();
  const { error: e } = await supabase.from('emergency_sessions').insert({
    family_id: ctx.active.familyId, kind, reason: input.reason?.trim() || null,
    activated_by: ctx.active.member.id, elevated_domains: domains.length ? domains : ['all'],
  });
  if (e) return actionFailure(e, 'Could not activate emergency mode.');

  await supabase.from('trust_audit_logs').insert({
    family_id: ctx.active.familyId, actor_kind: 'member', actor_id: ctx.active.member.id,
    domain: 'emergency', capability: 'automate', decision: 'emergency_override',
    reason: `Emergency mode activated (${kind})${input.reason ? `: ${input.reason}` : ''}`,
  });
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function endEmergencyAction(input: { id: string }): Promise<Result> {
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const { error: e } = await supabase.from('emergency_sessions')
    .update({ ended_at: new Date().toISOString(), ended_by: ctx.active.member.id })
    .eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (e) return actionFailure(e, 'Could not end emergency mode.');
  revalidatePath('/dashboard/trust');
  return { ok: true };
}
