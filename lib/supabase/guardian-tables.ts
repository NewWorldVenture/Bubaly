// Typed helpers for the Guardian tables added in migration 0091.
// database.types.ts doesn't include these (pending re-generation),
// so we use explicit type casts here.

import type { SupabaseClient } from '@supabase/supabase-js';

type GuardianContact = {
  id: string;
  family_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  avatar_url: string | null;
  trust_level: string;
  trust_override: boolean;
  member_id: string | null;
  spam_score: number;
  is_verified: boolean;
  verified_at: string | null;
  total_calls: number;
  total_sms: number;
  last_contact_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type GuardianMemberProfile = {
  id: string;
  family_id: string;
  member_id: string;
  guardian_phone: string | null;
  default_mode_immediate: string;
  default_mode_close: string;
  default_mode_trusted: string;
  default_mode_known: string;
  default_mode_unknown: string;
  default_mode_suspected_spam: string;
  default_mode_blocked: string;
  context_overrides: Record<string, string>;
  ai_persona_name: string;
  ai_greeting_template: string | null;
  emergency_always_ring: boolean;
  voicemail_greeting: string | null;
  current_context: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type GuardianRoutingRule = {
  id: string;
  family_id: string;
  member_id: string | null;
  name: string;
  description: string | null;
  is_active: boolean;
  priority: number;
  condition_contact_id: string | null;
  condition_trust_levels: string[] | null;
  condition_time_start: string | null;
  condition_time_end: string | null;
  condition_days_of_week: number[] | null;
  condition_contexts: string[] | null;
  condition_caller_pattern: string | null;
  action_routing_mode: string;
  action_notify_members: string[] | null;
  created_by: string | null;
  ai_suggested: boolean;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

type GuardianCommunication = {
  id: string;
  family_id: string;
  member_id: string | null;
  contact_id: string | null;
  comm_type: string;
  direction: string;
  from_number: string | null;
  to_number: string | null;
  from_name: string | null;
  body: string | null;
  summary: string | null;
  sentiment: string | null;
  trust_level_at_time: string | null;
  routing_mode_used: string | null;
  routing_rule_id: string | null;
  ai_decision_reason: string | null;
  scam_detected: boolean;
  scam_type: string | null;
  scam_confidence: number | null;
  call_duration_secs: number | null;
  call_recording_url: string | null;
  twilio_call_sid: string | null;
  twilio_sms_sid: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  created_at: string;
};

type GuardianScreeningSession = {
  id: string;
  family_id: string;
  communication_id: string | null;
  twilio_call_sid: string;
  caller_number: string | null;
  caller_name_stated: string | null;
  turn: number;
  status: string;
  messages: Array<{ role: string; content: string }>;
  ai_intent: string | null;
  ai_urgency: string | null;
  ai_risk: string | null;
  final_action: string | null;
  resolution_summary: string | null;
  created_at: string;
  updated_at: string;
};

type GuardianSuggestion = {
  id: string;
  family_id: string;
  suggestion_type: string;
  title: string;
  reasoning: string;
  evidence: Record<string, unknown> | null;
  proposed_contact_id: string | null;
  proposed_trust_level: string | null;
  proposed_rule_data: Record<string, unknown> | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  expires_at: string;
  created_at: string;
};

type GuardianEscalation = {
  id: string;
  family_id: string;
  communication_id: string | null;
  escalation_type: string;
  severity: string;
  description: string;
  caller_number: string | null;
  notified_member_ids: string[];
  push_sent: boolean;
  sms_sent: boolean;
  call_attempted: boolean;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  escalated_at: string;
  created_at: string;
};

type GuardianAuditLog = {
  id: string;
  family_id: string;
  actor_user_id: string | null;
  actor: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export type GuardianTables = {
  guardian_contacts: GuardianContact;
  guardian_member_profiles: GuardianMemberProfile;
  guardian_routing_rules: GuardianRoutingRule;
  guardian_communications: GuardianCommunication;
  guardian_screening_sessions: GuardianScreeningSession;
  guardian_suggestions: GuardianSuggestion;
  guardian_escalations: GuardianEscalation;
  guardian_audit_log: GuardianAuditLog;
};

/** Cast a Supabase client to also query the Guardian tables from migration 0091. */
export function withGuardianTables<T extends SupabaseClient>(client: T) {
  return client as T & {
    from<K extends keyof GuardianTables>(relation: K): ReturnType<T['from']>;
  };
}
