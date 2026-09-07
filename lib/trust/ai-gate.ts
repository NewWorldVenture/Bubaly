// lib/trust/ai-gate.ts — one gate for the AI surfaces that hold a client and a
// family id rather than a ServiceScope.
//
// `lib/ai/tools/execute.ts` is the full gate for the tool registry: family
// settings, then the engine, then the risk tier, then the ledger. Two other
// surfaces write family data and used to call the bare engine instead — the
// chat assistant's tool wrapper and Magic Import. The consequence was concrete:
// "Switch Bubaly off" in Settings → Bubaly AI stopped the run executor and the
// routine cron, and left chat and Magic Import creating events, chores,
// reminders and announcements.
//
// This is the same set of rules for those two, in one place, so they cannot
// drift apart again.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { behaviorForDomain, effectiveRisk } from '@/lib/ai/family-settings';
import { getTool } from '@/lib/ai/tools/registry';
import { readAISettings } from '@/lib/services/ai-settings';
import { riskToDecision, toolTags, type Capability, type Decision, type TrustRole } from '@/lib/trust/engine';
import { evaluateTrust, openApprovalRequest } from '@/lib/trust/server';

type DB = SupabaseClient<Database>;

export type AiGateRequest = {
  /** The tool's name as this surface spells it; registry aliases are resolved. */
  toolName: string;
  domain: string;
  actorId: string;
  actorRole: TrustRole;
  /** Display name of the agent asking, for the approval row. */
  agent: string;
  /**
   * The `family_members.id` of the person Bubaly is acting FOR.
   *
   * The actor is the agent — `actor.kind` is `'ai_agent'` — which is why
   * `openApprovalRequest` left `requested_by_member_id` null on every AI-filed
   * row. Nothing on the row said who asked, so an approval granted hours later
   * could only be replayed as the APPROVER: a note attributed to the parent who
   * released it, and (before it was pulled) an RSVP answering for them.
   *
   * Null when the surface genuinely cannot tell — a cron, or a session whose
   * roster row is missing. The replay then falls back to the approver, which is
   * what it always did.
   */
  onBehalfOfMemberId?: string | null;
  title: string;
  payload: Record<string, unknown>;
  confidence?: number;
  capability?: Capability;
};

export type AiGateOutcome =
  | { effect: 'allow' }
  | { effect: 'deny'; reason: string }
  | {
      effect: 'require_approval';
      reason: string;
      approvalId: string | null;
      /**
       * The approval was ALREADY waiting — this call filed nothing new. A resent
       * chat message must say so rather than reporting a fresh send, or one
       * intent reads as two cards in a parent's inbox (0273).
       */
      alreadyPending?: boolean;
    };

export async function gateAiAction(supabase: DB, familyId: string, req: AiGateRequest): Promise<AiGateOutcome> {
  const settings = await readAISettings(supabase, familyId);
  if (!settings.enabled) {
    // Switched off means switched off: no approval is opened, because there is
    // nothing for a parent to release — the family turned Bubaly's hands off.
    return { effect: 'deny', reason: 'Bubaly is switched off for this family in Settings → Bubaly AI.' };
  }

  const capability = req.capability ?? 'automate';

  // The registry knows this tool's declared risk under its legacy name (these
  // surfaces spell tools the old way, and every one is a registry alias), so
  // the family's per-tool overrides and their autonomy dial reach them too.
  const registryTool = getTool(req.toolName);
  const risk = registryTool ? effectiveRisk(settings, registryTool) : 'medium';

  const evaluateRequest = {
    actor: { kind: 'ai_agent' as const, id: req.actorId, role: req.actorRole },
    domain: req.domain,
    capability,
    agent: req.agent,
    title: req.title,
    payload: req.payload,
    context: {
      confidence: req.confidence ?? 0.85,
      // The tool's name rides along as a tag so a policy scoped by
      // `conditions.tags` to ONE tool — the narrow policies Autopilot learns
      // from repeated approvals — matches exactly that tool and nothing else
      // in the domain. Both spellings, because the policy names the canonical
      // one and this surface may still use the legacy alias.
      tags: toolTags(req.toolName, registryTool?.name ?? null),
    },
  };
  const { decision: engineDecision, approvalId: engineApprovalId, alreadyPending: engineAlreadyPending }
    = await evaluateTrust(supabase, familyId, evaluateRequest);

  // Same rule as the executor's gate: the tier speaks over the generic role
  // matrix, and over a policy that names no domain — where it may only tighten.
  const fromGenericRule = engineDecision.basis === 'role_default' || engineDecision.basis === 'fallback';
  const blanketAllow = engineDecision.basis === 'policy' && engineDecision.effect === 'allow' && engineDecision.policyScope === 'broad';
  let decision: Decision = engineDecision;
  if (fromGenericRule || blanketAllow) {
    const risked = riskToDecision({
      risk,
      actor: { kind: 'ai_agent', id: req.actorId, role: req.actorRole },
      domain: req.domain,
      capability,
      behavior: behaviorForDomain(settings, req.domain),
      explicitAllow: false,
    });
    if (risked && !(engineApprovalId && risked.effect === 'allow') && (fromGenericRule || risked.effect !== 'allow')) {
      decision = risked;
    }
  }

  if (decision.effect === 'deny') return { effect: 'deny', reason: decision.reason };
  if (decision.effect === 'require_approval') {
    // The engine files its own approval row; a tier that tightened an `allow`
    // into an approval has to file one too, or "sent for parent approval" names
    // nothing a parent can find.
    // A tier that tightened an `allow` files its own row; the engine's own
    // `alreadyPending` carries through when it filed one.
    const opened = engineApprovalId
      ? null
      : await openApprovalRequest(
        supabase,
        familyId,
        { ...evaluateRequest, payload: req.payload as unknown as Record<string, Json>, onBehalfOfMemberId: req.onBehalfOfMemberId ?? null },
        decision,
      );
    return {
      effect: 'require_approval',
      reason: decision.reason,
      approvalId: engineApprovalId ?? opened?.id ?? null,
      alreadyPending: engineAlreadyPending || (opened?.alreadyPending ?? false),
    };
  }
  return { effect: 'allow' };
}
