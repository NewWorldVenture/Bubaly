'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { CAPABILITIES, TRUST_DOMAINS, type Capability } from '@/lib/trust/engine';
import { delegationFromPreset, findSharingPreset } from '@/lib/trust/sharing-presets';
import { ledgerWriter, recordTrustChange } from '@/lib/trust/ledger';
import { APPROVAL_MODELS, thresholdFor } from '@/lib/approvals/threshold';
import type { Json } from '@/lib/database.types';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { scopeFromUserContext } from '@/lib/services/scope';
import { decide } from '@/lib/services/approvals';
import {
  acceptedPolicyName, policyCoversTool, policyProposalFromPayload, POLICY_SUGGESTION_KIND,
} from '@/lib/autopilot/policy-candidates';
import { loadPolicyCandidates } from '@/lib/autopilot/policy-scan';

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
/**
 * On this surface a write that changed nothing must not report success.
 *
 * `.eq('id', …).eq('family_id', …)` matches nothing for a stale id or one
 * belonging to another family, and an UPDATE or DELETE that matches nothing
 * SUCCEEDS — zero rows, no error. Everywhere else that is a stale-list
 * annoyance. Here the sentence the manager reads is about access: "policy
 * disabled", "access revoked", "emergency ended". Saying that of a delegation
 * still granting access, or an emergency session still elevating it, is the
 * one lie this page must not tell.
 *
 * `.select('id')` is what makes PostgREST return the affected rows at all.
 */
function changedNothing(rows: unknown[] | null): boolean {
  return !rows || rows.length === 0;
}

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
    const { data: rows, error: e } = await supabase.from('trust_policies').update(base)
      .eq('id', input.id).eq('family_id', ctx.active.familyId).select('id');
    if (e) return actionFailure(e, t('actions.couldNotUpdateThatPolicy'));
    if (changedNothing(rows)) return { ok: false, error: t('actions.couldNotUpdateThatPolicy') };
  } else {
    const { error: e } = await supabase.from('trust_policies').insert({ ...base, family_id: ctx.active.familyId, created_by: ctx.user.id });
    if (e) return actionFailure(e, t('actions.couldNotCreateThatPolicy'));
  }
  // The rule itself changed. Recorded in English, deliberately: this row is
  // evidence, read back long after the fact and possibly by someone who did not
  // write it, so it is not translated per request the way the UI is.
  await recordTrustChange(supabase, {
    familyId: ctx.active.familyId, actorMemberId: ctx.active.member.id,
    decision: 'policy_changed', domain: base.domain, capability: base.capability,
    reason: `${input.id ? 'Updated' : 'Created'} policy "${name}" — ${base.effect} for ${base.subject_kind}`,
    context: { policy: name, effect: base.effect, subjectKind: base.subject_kind, enabled: base.enabled },
  });
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function togglePolicyAction(input: { id: string; enabled: boolean }): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const { data: rows, error: e } = await supabase.from('trust_policies').update({ enabled: input.enabled })
    .eq('id', input.id).eq('family_id', ctx.active.familyId).select('id');
  if (e) return actionFailure(e, t('actions.couldNotUpdateThatPolicy'));
  if (changedNothing(rows)) return { ok: false, error: t('actions.couldNotUpdateThatPolicy') };
  await recordTrustChange(supabase, {
    familyId: ctx.active.familyId, actorMemberId: ctx.active.member.id,
    decision: 'policy_changed',
    reason: `Policy ${input.enabled ? 'enabled' : 'disabled'}`,
    context: { policyId: input.id, enabled: input.enabled },
  });
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function deletePolicyAction(input: { id: string }): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  const { data: rows, error: e } = await supabase.from('trust_policies').delete()
    .eq('id', input.id).eq('family_id', ctx.active.familyId).select('id');
  if (e) return actionFailure(e, t('actions.couldNotDeleteThatPolicy'));
  if (changedNothing(rows)) return { ok: false, error: t('actions.couldNotDeleteThatPolicy') };
  // A deleted policy leaves no row behind, so without this the strongest kind
  // of permission change is the one the ledger can say least about.
  await recordTrustChange(supabase, {
    familyId: ctx.active.familyId, actorMemberId: ctx.active.member.id,
    decision: 'policy_changed', reason: 'Policy deleted',
    context: { policyId: input.id, deleted: true },
  });
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
/** An accept's own 'approved' claim older than this, with no policy written, is abandoned work. */
const STALE_POLICY_CLAIM_MS = 2 * 60_000;

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
    .select('id, kind, status, payload, updated_at, resolved_by, resolved_at')
    .eq('id', input.suggestionId).eq('family_id', familyId).maybeSingle();
  if (readError) return actionFailure(readError, t('actions.couldNotReadThatSuggestion'));
  if (!suggestion || suggestion.kind !== POLICY_SUGGESTION_KIND) return { ok: false, error: t('actions.thatSuggestionDoesNotProposeAPolicy') };
  // 'approved' is this action's own claim (below). It is accepted again only
  // to finish a claim whose final stamp did not land, and only when the policy
  // it wrote is already held — never to write a second one.
  const resuming = suggestion.status === 'approved' && suggestion.resolved_by === ctx.user.id;
  if (suggestion.status !== 'open' && !resuming) return { ok: false, error: t('actions.thatSuggestionIsNoLongerOpen') };

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
  // A claim of yours with no policy behind it is an accept that stopped
  // between the claim and the write (a crash, a timeout). Left alone it sits
  // 'approved' for good: no one else may accept it and the scan never
  // re-offers it. Once it is older than any accept still in flight, the same
  // manager may take it again — re-claimed below, fenced on the version read,
  // so two retries still write one policy.
  const claimedAt = Date.parse(String(suggestion.resolved_at ?? ''));
  const staleClaim = resuming && !alreadyHeld && (!Number.isFinite(claimedAt) || Date.now() - claimedAt >= STALE_POLICY_CLAIM_MS);
  if (resuming && !alreadyHeld && !staleClaim) return { ok: false, error: t('actions.thatSuggestionIsNoLongerOpen') };

  if (!alreadyHeld) {
    // The stored payload is not evidence. autopilot_suggestions is family-
    // writable (the on-demand scan runs in the caller's session), so a member
    // could file a "suggestion" proposing any AI permission with any evidence
    // text and wait for a parent to accept it. Only a proposal the family's
    // real approval history supports right now is written, and it is written
    // from that re-derived candidate, not from the row.
    let candidates;
    try {
      candidates = await loadPolicyCandidates(supabase, familyId);
    } catch (e) {
      return actionFailure(e, t('actions.couldNotCreateThatPolicy'));
    }
    const supported = candidates.find((c) => c.domain === proposal.domain
      && c.capability === proposal.capability && c.toolName === proposal.tool);
    if (!supported) return { ok: false, error: t('actions.thatSuggestionDoesNotProposeAPolicy') };
    // Claim the suggestion BEFORE writing the policy: open -> approved,
    // fenced on the status and version read above. Two managers pressing
    // Accept together both saw 'open' and no held policy, and both wrote one
    // (trust_policies has no unique index to stop the second); an accept also
    // used to overwrite a dismissal or an archive that landed in between. Only
    // the accept whose claim matches a row may write.
    let claim = supabase.from('autopilot_suggestions')
      .update({ status: 'approved', resolved_at: new Date().toISOString(), resolved_by: ctx.user.id })
      .eq('id', suggestion.id).eq('family_id', familyId);
    // Re-taking an abandoned claim is fenced on the claim time read too: each
    // claim stamps a new one, so of two retries only the first matches.
    if (staleClaim) {
      claim = claim.eq('status', 'approved').eq('resolved_by', ctx.user.id);
      claim = suggestion.resolved_at ? claim.eq('resolved_at', suggestion.resolved_at) : claim.is('resolved_at', null);
    } else {
      claim = claim.eq('status', 'open');
    }
    if (suggestion.updated_at) claim = claim.eq('updated_at', suggestion.updated_at);
    const { data: claimed, error: claimError } = await claim.select('id');
    if (claimError) return actionFailure(claimError, t('actions.couldNotCreateThatPolicy'));
    if (wroteNoRows(claimed)) return { ok: false, error: t('actions.thatSuggestionIsNoLongerOpen') };
    const saved = await savePolicyAction({
      name: acceptedPolicyName({ tool: supported.toolName }),
      description: `Accepted from an Autopilot suggestion — ${supported.evidence}.`,
      domain: supported.domain,
      capability: supported.capability,
      subjectKind: 'ai',
      effect: 'allow',
      conditions: {
        tags: [supported.toolName],
        source: 'autopilot',
        suggestionId: suggestion.id,
        approvals: supported.approvals,
        acceptedAt: new Date().toISOString(),
      },
      priority: ACCEPTED_POLICY_PRIORITY,
      enabled: true,
    });
    if (!saved.ok) {
      // Release the claim so the offer is still there to accept.
      const { error: releaseError } = await supabase.from('autopilot_suggestions')
        .update({ status: 'open', resolved_at: null, resolved_by: null })
        .eq('id', suggestion.id).eq('family_id', familyId).eq('status', 'approved').eq('resolved_by', ctx.user.id);
      if (releaseError) console.error('[trust] suggestion claim release failed', { suggestionId: suggestion.id, error: releaseError });
      return saved;
    }
  }

  // The policies are already saved by here. A resolve matching no rows leaves the
  // suggestion sitting in the queue looking un-acted-on, and accepting it a second
  // time writes the SAME policies again — a duplicate set at the same priority,
  // which is how a permission nobody granted twice becomes hard to trace back to
  // one decision. The existing message already says the halves came apart; it just
  // never ran for the half that fails silently. Audit C1-S9-59.
  //
  // Compare-and-set: from this action's own claim when it wrote the policy,
  // or from the 'open' (or resumed 'approved') row it read when the family
  // already held one. A row dismissed or archived meanwhile matches nothing
  // and is never flipped back to executed.
  const fromStatus = alreadyHeld ? suggestion.status : 'approved';
  // A concurrent accept that already finished this exact resolution is success.
  const alreadyExecuted = async () => (await supabase.from('autopilot_suggestions')
    .select('status').eq('id', suggestion.id).eq('family_id', familyId).maybeSingle()).data?.status === 'executed';
  let resolve = supabase.from('autopilot_suggestions')
    .update({ status: 'executed', resolved_at: new Date().toISOString(), resolved_by: ctx.user.id })
    .eq('id', suggestion.id).eq('family_id', familyId).eq('status', fromStatus);
  if (alreadyHeld && suggestion.updated_at) resolve = resolve.eq('updated_at', suggestion.updated_at);
  const { data: resolved, error: resolveError } = await resolve.select('id');
  if (resolveError) return actionFailure(resolveError, t('actions.thePolicyWasSavedButTheSuggestion'));
  // When the policy was already held, this call wrote nothing: say so instead.
  if (wroteNoRows(resolved) && !await alreadyExecuted()) {
    console.error('[trust] suggestion resolve matched no rows', { suggestionId: suggestion.id, familyId });
    return { ok: false, error: !alreadyHeld ? t('actions.thePolicyWasSavedButTheSuggestion') : t('actions.thatSuggestionIsNoLongerOpen') };
  }

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
  // `.select('id')` on both branches, for the reason `deletePolicyAction` above
  // already gives: this is the permission surface, and the ledger is the record
  // of what changed on it. Without asking for the affected rows, PostgREST
  // returns none either way and neither this action nor the ledger entry below
  // could tell a real change from a no-op. Audit C1-S9-18.
  //
  // The two branches are NOT treated alike, because they do not mean alike.
  let cleared = 0;
  if (input.effect === 'clear') {
    const { data: rows, error: e } = await supabase.from('permission_grants').delete()
      .eq('family_id', ctx.active.familyId).eq('member_id', input.memberId).eq('domain', input.domain).eq('capability', input.capability)
      .select('id');
    if (e) return actionFailure(e, t('actions.couldNotClearThatPermission'));
    // Clearing is IDEMPOTENT: no row means the grant is already absent, which is
    // the end state the manager asked for. So zero rows is not a failure here —
    // but the ledger must not claim a clearance that did not happen, which is
    // what it said before, in the same words, either way.
    cleared = rows?.length ?? 0;
  } else {
    const { data: rows, error: e } = await supabase.from('permission_grants').upsert({
      family_id: ctx.active.familyId, member_id: input.memberId,
      domain: input.domain, capability: input.capability as Capability, effect: input.effect, created_by: ctx.user.id,
    }, { onConflict: 'family_id,member_id,domain,capability' }).select('id');
    if (e) return actionFailure(e, t('actions.couldNotSaveThatPermission'));
    // An upsert is NOT idempotent in the same way: it either inserts or updates,
    // so affecting no row means the grant was not stored. Telling a manager an
    // allow or deny is in force when it is not is the failure this whole
    // surface exists to prevent, so it is a hard failure like its five siblings.
    if (changedNothing(rows)) return { ok: false, error: t('actions.couldNotSaveThatPermission') };
  }
  await recordTrustChange(supabase, {
    familyId: ctx.active.familyId, actorMemberId: ctx.active.member.id,
    decision: 'grant_changed', domain: input.domain, capability: input.capability,
    reason: input.effect === 'clear'
      ? cleared > 0
        ? `Cleared the ${input.capability} grant on ${input.domain}`
        : `No ${input.capability} grant on ${input.domain} to clear`
      : `Set ${input.capability} on ${input.domain} to ${input.effect}`,
    context: { memberId: input.memberId, effect: input.effect, ...(input.effect === 'clear' ? { cleared } : {}) },
  });
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

  // Both ids must belong to THIS family. `trust_delegations` references
  // `family_members(id)` with nothing tying either column to `family_id`
  // (0093:69-71), so a uuid from another household satisfies the foreign key
  // and lands in this family's table. It grants nothing — `evaluateTrust`
  // matches `to_member_id` against members of this family only, and never reads
  // `from_member_id` — but it renders in the trust UI as a grant made BY
  // someone who is not in the household, on the one surface whose job is saying
  // who may act for whom.
  const { data: named, error: namedError } = await supabase
    .from('family_members').select('id')
    .eq('family_id', ctx.active.familyId)
    .in('id', [input.fromMemberId, input.toMemberId]);
  if (namedError) return actionFailure(namedError, t('actions.couldNotCreateThatDelegation'));
  if ((named ?? []).length !== 2) return { ok: false, error: t('actions.delegateToADifferentMember') };

  const { error: e } = await supabase.from('trust_delegations').insert({
    family_id: ctx.active.familyId,
    from_member_id: input.fromMemberId, to_member_id: input.toMemberId,
    domains, reason: input.reason?.trim() || null,
    expires_at: expires.toISOString(), created_by: ctx.user.id,
  });
  if (e) return actionFailure(e, t('actions.couldNotCreateThatDelegation'));
  // Handing someone else your authority is the change this surface exists to
  // make, and it was the one it said nothing about.
  await recordTrustChange(supabase, {
    familyId: ctx.active.familyId, actorMemberId: ctx.active.member.id,
    decision: 'delegation_changed',
    domain: domains.length === 1 ? domains[0] : null,
    reason: `Delegated ${domains.length ? domains.join(', ') : 'no domains'} until ${expires.toISOString()}`,
    context: {
      fromMemberId: input.fromMemberId, toMemberId: input.toMemberId,
      domains, expiresAt: expires.toISOString(),
    },
  });
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

/**
 * The Access & Sharing presets (M23). The client names a preset KEY and the two
 * members; the scope and the expiry are looked up here, on the server, from
 * `lib/trust/sharing-presets`. Letting the client post domains and an expiry
 * would make the preset a suggestion — "Babysitter tonight" could then write
 * `finances` for a year. The row itself is written by `createDelegationAction`,
 * which keeps the manager check, the future-expiry check and the domain filter
 * in one place.
 */
export async function createSharingPresetAction(input: {
  presetKey: string; fromMemberId: string; toMemberId: string;
}): Promise<Result> {
  const t = await getTranslations();
  const preset = findSharingPreset(input.presetKey);
  if (!preset) return { ok: false, error: t('actions.unknownSharingPreset') };
  const delegation = delegationFromPreset(preset, {
    fromMemberId: input.fromMemberId,
    toMemberId: input.toMemberId,
    // Persisted and read back on this page, so it is stored in the manager's
    // own language rather than always in English.
    reason: t(preset.reasonKey),
  });
  return createDelegationAction(delegation);
}

export async function revokeDelegationAction(input: { id: string }): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  // "Access revoked" over a delegation that is still granting access is the
  // sharpest form of this on the whole surface.
  const { data: rows, error: e } = await supabase.from('trust_delegations').update({ revoked_at: new Date().toISOString() })
    .eq('id', input.id).eq('family_id', ctx.active.familyId).select('id');
  if (e) return actionFailure(e, t('actions.couldNotRevokeThatDelegation'));
  if (changedNothing(rows)) return { ok: false, error: t('actions.couldNotRevokeThatDelegation') };
  await recordTrustChange(supabase, {
    familyId: ctx.active.familyId, actorMemberId: ctx.active.member.id,
    decision: 'delegation_changed', reason: 'Delegation revoked',
    context: { delegationId: input.id, revoked: true },
  });
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
  //
  // This row is the ONLY record of who turned emergency mode on and why, and
  // emergency elevation outranks every deny, policy and risk tier — it is the
  // most powerful state the trust engine has. The insert resolves with
  // { data, error } rather than throwing, and the result was discarded, so a
  // refused write left the family with a live elevation and nothing saying who
  // started it. dashboard/trust renders these rows and api/privacy/export cites
  // them, so the absence is visible exactly where someone goes to ask.
  //
  // Non-fatal, deliberately, and for the same reason as lib/trust/server.ts: the
  // emergency_sessions insert above already succeeded, so the elevation IS live.
  // Returning an error here would tell a parent mid-emergency that it failed,
  // and the likely next move — activate it again — is worse than a missing log
  // line. So it must not fail; it must not be silent either.
  const { error: auditError } = await (await ledgerWriter(supabase)).from('trust_audit_logs').insert({
    family_id: ctx.active.familyId, actor_kind: 'member', actor_id: ctx.active.member.id,
    domain: 'emergency', capability: 'automate', decision: 'emergency_override',
    reason: `Emergency mode activated (${kind})${input.reason ? `: ${input.reason}` : ''}`,
  });
  if (auditError) {
    console.error('[trust] emergency mode was activated but not recorded',
      { familyId: ctx.active.familyId, kind, activatedBy: ctx.active.member.id }, auditError);
  }
  revalidatePath('/dashboard/trust');
  return { ok: true };
}

export async function endEmergencyAction(input: { id: string }): Promise<Result> {
  const t = await getTranslations();
  const { ctx, error } = await managerCtx();
  if (!ctx) return { ok: false, error };
  const supabase = await createServer();
  // An emergency session that did not end is one still elevating access.
  const { data: rows, error: e } = await supabase.from('emergency_sessions')
    .update({ ended_at: new Date().toISOString(), ended_by: ctx.active.member.id })
    .eq('id', input.id).eq('family_id', ctx.active.familyId).select('id');
  if (e) return actionFailure(e, t('actions.couldNotEndEmergencyMode'));
  if (changedNothing(rows)) return { ok: false, error: t('actions.couldNotEndEmergencyMode') };
  // Activation was recorded and the end was not, so the ledger could show an
  // override that outranks every deny with no sign of it ever stopping. The
  // schema has reserved `emergency_ended` since the table shipped.
  await recordTrustChange(supabase, {
    familyId: ctx.active.familyId, actorMemberId: ctx.active.member.id,
    decision: 'emergency_ended', domain: 'emergency', capability: 'automate',
    reason: 'Emergency mode ended',
    context: { sessionId: input.id },
  });
  revalidatePath('/dashboard/trust');
  return { ok: true };
}
