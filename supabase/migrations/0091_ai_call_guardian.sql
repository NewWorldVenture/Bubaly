-- 0091_ai_call_guardian.sql
-- AI Call Guardian™ — intelligent communication protection and routing.
-- Covers: Family Trust Graph, routing profiles per member, rules engine,
-- full communications log, AI screening sessions, adaptive suggestions,
-- and emergency escalation tracking.
-- All tables are family-scoped with RLS via is_family_member().

-- ─────────────────────────────────────────────────
-- TRUST LEVELS ENUM
-- ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.guardian_trust_level AS ENUM (
    'immediate_family',   -- ★★★★★ ring immediately
    'close_family',       -- ★★★★  ring immediately
    'trusted_friend',     -- ★★★   ring immediately
    'known_contact',      -- ★★    AI screens first
    'unknown',            -- ★     AI handles, notifies
    'suspected_spam',     -- ⚠     AI deflects
    'blocked'             -- ❌    hang up / delete
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────
-- ROUTING MODE ENUM
-- ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.guardian_routing_mode AS ENUM (
    'immediate_ring',       -- ring family member now
    'immediate_ai_summary', -- ring + live AI transcript
    'ai_handle_first',      -- AI screens, escalates if urgent
    'voicemail_first',      -- voicemail, AI transcribes
    'silent_handling',      -- AI handles entirely, summary later
    'blocked'               -- hang up / block
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────
-- COMMUNICATION TYPE ENUM
-- ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.guardian_comm_type AS ENUM (
    'call_inbound',
    'call_outbound',
    'sms_inbound',
    'sms_outbound',
    'whatsapp_inbound',
    'whatsapp_outbound',
    'email_inbound'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────
-- GUARDIAN CONTACTS (Family Trust Graph™)
-- One row per unique phone/email the family has seen or added.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_contacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  -- Contact identity
  name                text,
  phone               text,                         -- E.164 format e.g. +15551234567
  email               text,
  notes               text,
  avatar_url          text,
  -- Trust
  trust_level         public.guardian_trust_level NOT NULL DEFAULT 'unknown',
  trust_override      boolean NOT NULL DEFAULT false, -- true = parent set manually; false = AI inferred
  -- Linked family member this contact is associated with (optional)
  member_id           uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  -- Scam intelligence
  spam_score          integer NOT NULL DEFAULT 0 CHECK (spam_score >= 0 AND spam_score <= 100),
  is_verified         boolean NOT NULL DEFAULT false,
  verified_at         timestamptz,
  -- Stats
  total_calls         integer NOT NULL DEFAULT 0,
  total_sms           integer NOT NULL DEFAULT 0,
  last_contact_at     timestamptz,
  -- Meta
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_contacts" ON public.guardian_contacts;
CREATE POLICY "Family member can view guardian_contacts" ON public.guardian_contacts
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Family member can manage guardian_contacts" ON public.guardian_contacts;
CREATE POLICY "Family member can manage guardian_contacts" ON public.guardian_contacts
  FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id));

DROP TRIGGER IF EXISTS trg_guardian_contacts_updated_at ON public.guardian_contacts;
CREATE TRIGGER trg_guardian_contacts_updated_at
  BEFORE UPDATE ON public.guardian_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS guardian_contacts_family_phone ON public.guardian_contacts(family_id, phone);
CREATE INDEX IF NOT EXISTS guardian_contacts_family_email ON public.guardian_contacts(family_id, email);
CREATE UNIQUE INDEX IF NOT EXISTS guardian_contacts_family_phone_unique
  ON public.guardian_contacts(family_id, phone) WHERE phone IS NOT NULL;

-- ─────────────────────────────────────────────────
-- GUARDIAN MEMBER PROFILES
-- Per-family-member routing configuration.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_member_profiles (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id                   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id                   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  -- The Bubaly phone number assigned to this member (Twilio number)
  guardian_phone              text,
  -- Default routing per trust level
  default_mode_immediate      public.guardian_routing_mode NOT NULL DEFAULT 'immediate_ring',
  default_mode_close          public.guardian_routing_mode NOT NULL DEFAULT 'immediate_ring',
  default_mode_trusted        public.guardian_routing_mode NOT NULL DEFAULT 'immediate_ring',
  default_mode_known          public.guardian_routing_mode NOT NULL DEFAULT 'ai_handle_first',
  default_mode_unknown        public.guardian_routing_mode NOT NULL DEFAULT 'ai_handle_first',
  default_mode_suspected_spam public.guardian_routing_mode NOT NULL DEFAULT 'silent_handling',
  default_mode_blocked        public.guardian_routing_mode NOT NULL DEFAULT 'blocked',
  -- Context-aware overrides (JSONB map of context → routing_mode)
  -- e.g. {"driving":"voicemail_first","meeting":"ai_handle_first","sleeping":"silent_handling"}
  context_overrides           jsonb NOT NULL DEFAULT '{}',
  -- AI persona name (defaults to "Bubaly")
  ai_persona_name             text NOT NULL DEFAULT 'Bubaly',
  -- AI screening greeting template
  ai_greeting_template        text,
  -- Emergency contacts — always ring through regardless of mode
  emergency_always_ring       boolean NOT NULL DEFAULT true,
  -- Voicemail greeting (TTS text)
  voicemail_greeting          text,
  -- Active context (updated by app when user changes state)
  current_context             text CHECK (current_context IN ('normal','driving','meeting','sleeping','vacation','do_not_disturb')) DEFAULT 'normal',
  is_active                   boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(family_id, member_id)
);

ALTER TABLE public.guardian_member_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_member_profiles" ON public.guardian_member_profiles;
CREATE POLICY "Family member can view guardian_member_profiles" ON public.guardian_member_profiles
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Family member can manage guardian_member_profiles" ON public.guardian_member_profiles;
CREATE POLICY "Family member can manage guardian_member_profiles" ON public.guardian_member_profiles
  FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id));

DROP TRIGGER IF EXISTS trg_guardian_member_profiles_updated_at ON public.guardian_member_profiles;
CREATE TRIGGER trg_guardian_member_profiles_updated_at
  BEFORE UPDATE ON public.guardian_member_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- GUARDIAN ROUTING RULES
-- Deterministic rules that sit beneath AI decisions.
-- Parents approve all changes; AI can only suggest.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_routing_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id         uuid REFERENCES public.family_members(id) ON DELETE CASCADE, -- null = family-wide
  -- Rule metadata
  name              text NOT NULL,
  description       text,
  is_active         boolean NOT NULL DEFAULT true,
  priority          integer NOT NULL DEFAULT 100,   -- lower = higher priority
  -- Conditions (all must match — AND logic)
  condition_contact_id     uuid REFERENCES public.guardian_contacts(id) ON DELETE CASCADE,
  condition_trust_levels   text[],   -- array of trust_level values
  condition_time_start     time,     -- e.g. '22:00' (local family time)
  condition_time_end       time,     -- e.g. '07:00'
  condition_days_of_week   integer[], -- 0=Sun, 1=Mon...6=Sat
  condition_contexts       text[],   -- ['driving','meeting']
  condition_caller_pattern text,     -- regex on caller phone/name
  -- Action
  action_routing_mode      public.guardian_routing_mode NOT NULL DEFAULT 'ai_handle_first',
  action_notify_members    uuid[],   -- member IDs to notify
  -- Audit
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ai_suggested      boolean NOT NULL DEFAULT false,
  approved_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_routing_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_routing_rules" ON public.guardian_routing_rules;
CREATE POLICY "Family member can view guardian_routing_rules" ON public.guardian_routing_rules
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Family member can manage guardian_routing_rules" ON public.guardian_routing_rules;
CREATE POLICY "Family member can manage guardian_routing_rules" ON public.guardian_routing_rules
  FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id));

DROP TRIGGER IF EXISTS trg_guardian_routing_rules_updated_at ON public.guardian_routing_rules;
CREATE TRIGGER trg_guardian_routing_rules_updated_at
  BEFORE UPDATE ON public.guardian_routing_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- GUARDIAN COMMUNICATIONS
-- Immutable log of every call/SMS/email handled.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_communications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id           uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  contact_id          uuid REFERENCES public.guardian_contacts(id) ON DELETE SET NULL,
  -- Communication details
  comm_type           public.guardian_comm_type NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_number         text,
  to_number           text,
  from_name           text,
  -- Content
  body                text,        -- SMS/email body or call transcript
  summary             text,        -- AI-generated 1-2 sentence summary
  sentiment           text CHECK (sentiment IN ('positive','neutral','negative','urgent','suspicious')),
  -- Decision
  trust_level_at_time public.guardian_trust_level,
  routing_mode_used   public.guardian_routing_mode,
  routing_rule_id     uuid REFERENCES public.guardian_routing_rules(id) ON DELETE SET NULL,
  ai_decision_reason  text,        -- explainable AI: why this routing was chosen
  scam_detected       boolean NOT NULL DEFAULT false,
  scam_type           text,        -- 'robocall','warranty','irs','grandparent', etc.
  scam_confidence     integer CHECK (scam_confidence >= 0 AND scam_confidence <= 100),
  -- Call-specific
  call_duration_secs  integer,
  call_recording_url  text,        -- Twilio recording URL (if enabled)
  twilio_call_sid     text UNIQUE,
  twilio_sms_sid      text UNIQUE,
  -- Status
  status              text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','screening','handled','escalated','blocked','missed','failed')),
  -- Timestamps
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_communications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_communications" ON public.guardian_communications;
CREATE POLICY "Family member can view guardian_communications" ON public.guardian_communications
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Service can insert guardian_communications" ON public.guardian_communications;
CREATE POLICY "Service can insert guardian_communications" ON public.guardian_communications
  FOR INSERT TO authenticated WITH CHECK (is_family_member(family_id));

CREATE INDEX IF NOT EXISTS guardian_communications_family_started ON public.guardian_communications(family_id, started_at DESC);
CREATE INDEX IF NOT EXISTS guardian_communications_member ON public.guardian_communications(member_id, started_at DESC);
CREATE INDEX IF NOT EXISTS guardian_communications_twilio_call ON public.guardian_communications(twilio_call_sid) WHERE twilio_call_sid IS NOT NULL;

-- ─────────────────────────────────────────────────
-- GUARDIAN SCREENING SESSIONS
-- Active AI-screening conversation state (persisted across Twilio gather callbacks).
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_screening_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  communication_id  uuid REFERENCES public.guardian_communications(id) ON DELETE CASCADE,
  twilio_call_sid   text NOT NULL UNIQUE,
  -- Session state
  caller_number     text,
  caller_name_stated text,         -- what the caller said their name was
  turn              integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','escalated','resolved','timed_out')),
  -- Conversation history (array of {role, content} objects)
  messages          jsonb NOT NULL DEFAULT '[]',
  -- AI verdicts
  ai_intent         text,          -- 'appointment','sales','scam','emergency','personal', etc.
  ai_urgency        text CHECK (ai_urgency IN ('low','medium','high','emergency')),
  ai_risk           text CHECK (ai_risk IN ('safe','suspicious','likely_scam','definite_scam')),
  final_action      text CHECK (final_action IN ('transfer','voicemail','hang_up','notify')),
  resolution_summary text,
  -- Timestamps
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_screening_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_screening_sessions" ON public.guardian_screening_sessions;
CREATE POLICY "Family member can view guardian_screening_sessions" ON public.guardian_screening_sessions
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP TRIGGER IF EXISTS trg_guardian_screening_sessions_updated_at ON public.guardian_screening_sessions;
CREATE TRIGGER trg_guardian_screening_sessions_updated_at
  BEFORE UPDATE ON public.guardian_screening_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- GUARDIAN SUGGESTIONS
-- AI-proposed rule changes that require parent approval before taking effect.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_suggestions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  -- What the AI wants to change
  suggestion_type   text NOT NULL CHECK (suggestion_type IN ('new_rule','update_trust','update_routing','block_contact','flag_scam')),
  title             text NOT NULL,
  reasoning         text NOT NULL,  -- explainable AI: why this is suggested
  evidence          jsonb,          -- communication IDs, patterns that triggered suggestion
  -- Proposed values
  proposed_contact_id  uuid REFERENCES public.guardian_contacts(id) ON DELETE CASCADE,
  proposed_trust_level public.guardian_trust_level,
  proposed_rule_data   jsonb,       -- full rule object for new_rule type
  -- Review
  status            text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','dismissed','auto_dismissed')),
  reviewed_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  review_note       text,
  -- Expiry (auto-dismiss old suggestions)
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '30 days',
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_suggestions" ON public.guardian_suggestions;
CREATE POLICY "Family member can view guardian_suggestions" ON public.guardian_suggestions
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Family member can manage guardian_suggestions" ON public.guardian_suggestions;
CREATE POLICY "Family member can manage guardian_suggestions" ON public.guardian_suggestions
  FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id));

CREATE INDEX IF NOT EXISTS guardian_suggestions_family_status ON public.guardian_suggestions(family_id, status, created_at DESC);

-- ─────────────────────────────────────────────────
-- GUARDIAN ESCALATIONS
-- Emergency calls that required immediate family alerting.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_escalations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  communication_id    uuid REFERENCES public.guardian_communications(id) ON DELETE SET NULL,
  -- Escalation details
  escalation_type     text NOT NULL CHECK (escalation_type IN ('emergency_call','medical','police','fire','child_safety','urgent_personal')),
  severity            text NOT NULL CHECK (severity IN ('high','critical')) DEFAULT 'high',
  description         text NOT NULL,
  caller_number       text,
  -- Notification tracking
  notified_member_ids uuid[],
  push_sent           boolean NOT NULL DEFAULT false,
  sms_sent            boolean NOT NULL DEFAULT false,
  call_attempted      boolean NOT NULL DEFAULT false,
  -- Acknowledgement
  acknowledged_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_at     timestamptz,
  -- Timing
  escalated_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_escalations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_escalations" ON public.guardian_escalations;
CREATE POLICY "Family member can view guardian_escalations" ON public.guardian_escalations
  FOR SELECT TO authenticated USING (is_family_member(family_id));

CREATE INDEX IF NOT EXISTS guardian_escalations_family ON public.guardian_escalations(family_id, escalated_at DESC);

-- ─────────────────────────────────────────────────
-- GUARDIAN AUDIT LOG
-- Immutable record of every Guardian action for trust and compliance.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- 'ai' means the AI system did it; user_id links to who when a human did it
  actor         text NOT NULL CHECK (actor IN ('ai','parent','system')),
  action        text NOT NULL,   -- e.g. 'contact.trust_updated', 'rule.created', 'call.screened'
  entity_type   text,            -- table name
  entity_id     uuid,
  detail        jsonb,           -- before/after for updates
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_audit_log" ON public.guardian_audit_log;
CREATE POLICY "Family member can view guardian_audit_log" ON public.guardian_audit_log
  FOR SELECT TO authenticated USING (is_family_member(family_id));

CREATE INDEX IF NOT EXISTS guardian_audit_log_family ON public.guardian_audit_log(family_id, created_at DESC);
