// lib/guardian/pipeline.ts — Communication Decision Pipeline.
// Orchestrates: ID → Trust → Risk → Intent → Urgency → Context → Rules → AI Decision → Action

import type { TrustLevel } from './trust';
import { trustFromSpamScore, explainTrustDecision } from './trust';
import { evaluateRules, buildRuleContext, type GuardianRule } from './rules';
import { detectScamFromText, type ScamType } from './scam';
import { applySeasonalBoost } from './seasonal';
import type { SupabaseClient } from '@supabase/supabase-js';

export type RoutingMode =
  | 'immediate_ring'
  | 'immediate_ai_summary'
  | 'ai_handle_first'
  | 'voicemail_first'
  | 'silent_handling'
  | 'blocked';

export const ROUTING_MODE_LABELS: Record<RoutingMode, string> = {
  immediate_ring: 'Ring Immediately',
  immediate_ai_summary: 'Ring + AI Summary',
  ai_handle_first: 'AI Screens First',
  voicemail_first: 'Voicemail First',
  silent_handling: 'Silent — AI Handles',
  blocked: 'Blocked',
};

export const ROUTING_MODE_DESCRIPTIONS: Record<RoutingMode, string> = {
  immediate_ring: 'Call rings through directly, no screening.',
  immediate_ai_summary: 'Rings through with live AI transcript alongside.',
  ai_handle_first: 'Bubaly AI screens the caller; connects or summarizes.',
  voicemail_first: 'Goes to voicemail; AI transcribes and summarizes.',
  silent_handling: 'Bubaly handles the call entirely; you get a summary later.',
  blocked: 'Call is declined immediately.',
};

export type PipelineInput = {
  callerPhone: string | null;
  callerName: string | null;   // from caller ID / SIP header
  familyId: string;
  memberId: string | null;     // which family member the call is for
  callSid?: string;            // Twilio call SID
  initialTranscript?: string;  // first words detected (if speech-to-text available)
};

export type PipelineResult = {
  routingMode: RoutingMode;
  trustLevel: TrustLevel;
  contactId: string | null;
  contactName: string | null;
  spamScore: number;
  scamDetected: boolean;
  scamType: string | null;
  ruleId: string | null;
  reason: string;              // explainable AI string
  shouldEscalate: boolean;     // true if emergency detected
  memberProfile: MemberProfile | null;
};

export type MemberProfile = {
  id: string;
  member_id: string;
  ai_persona_name: string;
  ai_greeting_template: string | null;
  current_context: string;
  guardian_phone: string | null;
  default_mode_immediate: RoutingMode;
  default_mode_close: RoutingMode;
  default_mode_trusted: RoutingMode;
  default_mode_known: RoutingMode;
  default_mode_unknown: RoutingMode;
  default_mode_suspected_spam: RoutingMode;
  default_mode_blocked: RoutingMode;
  context_overrides: Record<string, RoutingMode>;
  voicemail_greeting: string | null;
};

/** Look up a contact in the family trust graph by phone number. */
async function lookupContact(
  supabase: SupabaseClient,
  familyId: string,
  phone: string | null,
): Promise<{ id: string; name: string | null; trust_level: TrustLevel; spam_score: number } | null> {
  if (!phone) return null;
  const { data } = await supabase
    .from('guardian_contacts')
    .select('id, name, trust_level, spam_score')
    .eq('family_id', familyId)
    .eq('phone', phone)
    .maybeSingle();
  return data as { id: string; name: string | null; trust_level: TrustLevel; spam_score: number } | null;
}

/** Load member routing profile. */
async function loadMemberProfile(
  supabase: SupabaseClient,
  familyId: string,
  memberId: string | null,
): Promise<MemberProfile | null> {
  if (!memberId) return null;
  const { data } = await supabase
    .from('guardian_member_profiles')
    .select('*')
    .eq('family_id', familyId)
    .eq('member_id', memberId)
    .eq('is_active', true)
    .maybeSingle();
  if (!data) return null;
  return {
    ...(data as MemberProfile),
    context_overrides: (data as { context_overrides?: Record<string, RoutingMode> }).context_overrides ?? {},
  };
}

/** Load active routing rules for this family/member. */
async function loadRules(
  supabase: SupabaseClient,
  familyId: string,
  memberId: string | null,
): Promise<GuardianRule[]> {
  const { data } = await supabase
    .from('guardian_routing_rules')
    .select('*')
    .eq('family_id', familyId)
    .eq('is_active', true)
    .or(memberId ? `member_id.is.null,member_id.eq.${memberId}` : 'member_id.is.null')
    .order('priority', { ascending: true });
  return (data ?? []) as unknown as GuardianRule[];
}

/** Resolve routing mode from profile based on trust level + current context. */
function resolveFromProfile(profile: MemberProfile, trust: TrustLevel): RoutingMode {
  // Check context overrides first
  const ctx = profile.current_context;
  if (ctx !== 'normal' && profile.context_overrides[ctx]) {
    return profile.context_overrides[ctx];
  }
  const map: Record<TrustLevel, RoutingMode> = {
    immediate_family: profile.default_mode_immediate,
    close_family: profile.default_mode_close,
    trusted_friend: profile.default_mode_trusted,
    known_contact: profile.default_mode_known,
    unknown: profile.default_mode_unknown,
    suspected_spam: profile.default_mode_suspected_spam,
    blocked: profile.default_mode_blocked,
  };
  return map[trust];
}

/** Fallback routing when no profile exists. */
function defaultRouting(trust: TrustLevel): RoutingMode {
  if (['immediate_family', 'close_family', 'trusted_friend'].includes(trust)) return 'immediate_ring';
  if (trust === 'blocked') return 'blocked';
  if (trust === 'suspected_spam') return 'silent_handling';
  return 'ai_handle_first';
}

/**
 * The Communication Decision Pipeline.
 * Called at the start of every inbound call/SMS to determine how to handle it.
 */
export async function runDecisionPipeline(
  supabase: SupabaseClient,
  input: PipelineInput,
): Promise<PipelineResult> {
  const { callerPhone, callerName, familyId, memberId, initialTranscript } = input;

  // Step 1: Identify caller in trust graph
  const contact = await lookupContact(supabase, familyId, callerPhone);

  // Step 2: Determine trust level
  let trust: TrustLevel = contact?.trust_level ?? 'unknown';
  let spamScore = contact?.spam_score ?? 0;

  // Step 3: Quick scam check on any initial transcript
  let scamDetected = false;
  let scamType: string | null = null;
  let seasonalNote = '';
  if (initialTranscript) {
    const scamResult = detectScamFromText(initialTranscript, callerPhone ?? undefined);
    if (scamResult.isScam) {
      // Seasonal Intelligence — boost confidence for scams that are "in season"
      // (IRS in tax season, charity/gift-card over the holidays, etc.).
      const seasonal = applySeasonalBoost(scamResult.scamType as ScamType | null, scamResult.confidence);
      scamDetected = true;
      scamType = scamResult.scamType;
      spamScore = Math.max(spamScore, seasonal.confidence);
      if (seasonal.boosted) seasonalNote = seasonal.note;
      if (seasonal.confidence >= 80) trust = 'suspected_spam';
    }
  }

  // Step 4: Load member profile
  const profile = await loadMemberProfile(supabase, familyId, memberId);

  // Step 5: Load and evaluate rules
  const rules = await loadRules(supabase, familyId, memberId);
  const ruleCtx = buildRuleContext({
    contactId: contact?.id ?? null,
    trustLevel: trust,
    callerPhone,
    callerName,
    memberContext: profile?.current_context ?? 'normal',
  });
  const ruleResult = evaluateRules(rules, ruleCtx);

  // Step 6: Determine final routing mode
  let routingMode: RoutingMode;
  let ruleId: string | null = null;

  if (ruleResult.matched && ruleResult.routingMode) {
    routingMode = ruleResult.routingMode;
    ruleId = ruleResult.rule?.id ?? null;
  } else if (profile) {
    routingMode = resolveFromProfile(profile, trust);
  } else {
    routingMode = defaultRouting(trust);
  }

  // Step 7: Emergency override — if initial transcript mentions emergency keywords, always escalate
  const shouldEscalate = Boolean(
    initialTranscript &&
    /\b(911|emergency|help me|heart attack|stroke|fire|crash|accident|hospital|police|hurt|dying)\b/i.test(initialTranscript)
  );
  if (shouldEscalate) routingMode = 'immediate_ring';

  let reason = ruleResult.matched
    ? ruleResult.reason
    : explainTrustDecision(trust, contact?.name ?? callerName, spamScore);
  if (seasonalNote) reason = `${reason} ${seasonalNote}`;

  return {
    routingMode,
    trustLevel: trust,
    contactId: contact?.id ?? null,
    contactName: contact?.name ?? callerName,
    spamScore,
    scamDetected,
    scamType,
    ruleId,
    reason,
    shouldEscalate,
    memberProfile: profile,
  };
}
