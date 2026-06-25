-- ════════════════════════════════════════════════════════════════════════════
-- Family Trust & Permissions Engine — a core platform layer.
-- Governs every AI action, member capability, delegation, and approval workflow.
--
-- Tables:
--   trust_policies      — the Household Policy Engine (declarative allow/deny/approve rules)
--   permission_grants   — fine-grained per-member domain/capability overrides
--   trust_delegations   — temporary, auto-expiring authority transfers
--   approval_requests   — the approval inbox + workflow state
--   trust_scores        — dynamic, continuously-updated trust per actor
--   emergency_sessions  — Emergency Operations Mode (time-boxed elevation)
--   trust_audit_logs    — explainability + complete decision audit trail
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Household Policy Engine ────────────────────────────────────────────────
-- A declarative rule: "for {domain}/{capability}, when {conditions}, {effect}".
-- The engine evaluates the highest-priority matching policy for every action.
CREATE TABLE IF NOT EXISTS public.trust_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description   text CHECK (char_length(description) <= 1000),
  domain        text NOT NULL DEFAULT 'all',          -- e.g. medical, finances, calendar, 'all'
  capability    text NOT NULL DEFAULT 'automate'      -- view|create|edit|delete|approve|delegate|automate|share|archive|export|all
                  CHECK (capability IN ('view','create','edit','delete','approve','delegate','automate','share','archive','export','all')),
  -- Who this policy applies to: a role, a specific member, or everyone.
  subject_kind  text NOT NULL DEFAULT 'role'
                  CHECK (subject_kind IN ('role','member','ai','everyone')),
  subject_role  text,                                 -- when subject_kind='role'
  subject_member_id uuid REFERENCES public.family_members(id) ON DELETE CASCADE,
  effect        text NOT NULL DEFAULT 'require_approval'
                  CHECK (effect IN ('allow','deny','require_approval','auto_approve')),
  -- Structured conditions, e.g. {"maxAmountCents":5000,"minConfidence":0.95,"timeStart":"16:00","timeEnd":"22:00"}.
  conditions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- For require_approval: how many approvers + which model.
  approval_model text NOT NULL DEFAULT 'single'
                  CHECK (approval_model IN ('single','two_parent','first_available','consensus','sequential')),
  required_approvals smallint NOT NULL DEFAULT 1 CHECK (required_approvals BETWEEN 1 AND 5),
  priority      smallint NOT NULL DEFAULT 100,        -- higher wins on conflict
  enabled       boolean NOT NULL DEFAULT true,
  is_system     boolean NOT NULL DEFAULT false,       -- seeded default policies
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trust_policies_family ON public.trust_policies(family_id, enabled);
CREATE INDEX IF NOT EXISTS idx_trust_policies_domain ON public.trust_policies(family_id, domain, capability);

-- ─── Fine-grained permission grants ─────────────────────────────────────────
-- Per-member override of the role-default capability matrix.
CREATE TABLE IF NOT EXISTS public.permission_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  domain        text NOT NULL,
  capability    text NOT NULL
                  CHECK (capability IN ('view','create','edit','delete','approve','delegate','automate','share','archive','export')),
  effect        text NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, member_id, domain, capability)
);
CREATE INDEX IF NOT EXISTS idx_permission_grants_member ON public.permission_grants(family_id, member_id);

-- ─── Temporary delegation ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trust_delegations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  from_member_id uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  to_member_id  uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  domains       text[] NOT NULL DEFAULT '{}',         -- empty = all delegable domains
  reason        text CHECK (char_length(reason) <= 500),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,                 -- delegation MUST expire
  revoked_at    timestamptz,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  CHECK (from_member_id <> to_member_id)
);
CREATE INDEX IF NOT EXISTS idx_trust_delegations_active ON public.trust_delegations(family_id, to_member_id, expires_at) WHERE revoked_at IS NULL;

-- ─── Approval requests (inbox + workflow) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.approval_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  domain        text NOT NULL,
  capability    text NOT NULL DEFAULT 'automate',
  -- Who/what is requesting: an AI agent or a member.
  requested_by_kind text NOT NULL DEFAULT 'ai' CHECK (requested_by_kind IN ('ai','member')),
  requested_by_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  agent         text,                                  -- the AI agent name, when requested_by_kind='ai'
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary       text CHECK (char_length(summary) <= 2000),
  -- The proposed action payload (so it can be executed on approval).
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount_cents  bigint,                                -- when the action has a cost
  confidence    numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  policy_id     uuid REFERENCES public.trust_policies(id) ON DELETE SET NULL,
  reasoning     text,                                  -- why approval was required (explainability)
  approval_model text NOT NULL DEFAULT 'single'
                  CHECK (approval_model IN ('single','two_parent','first_available','consensus','sequential')),
  required_approvals smallint NOT NULL DEFAULT 1,
  approvals     jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [{member_id, decision, note, at}]
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','modified','expired','cancelled')),
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  decided_by    uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  expires_at    timestamptz,
  executed_at   timestamptz,
  execution_result text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON public.approval_requests(family_id, status, created_at DESC);

-- ─── Dynamic trust scores ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trust_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('member','ai_agent','contact','organization','automation','integration')),
  actor_id      text NOT NULL,                         -- member uuid, agent name, contact id, etc.
  score         numeric(5,2) NOT NULL DEFAULT 50 CHECK (score >= 0 AND score <= 100),
  factors       jsonb NOT NULL DEFAULT '{}'::jsonb,    -- {history, reliability, verified, ...}
  verified      boolean NOT NULL DEFAULT false,
  interactions  integer NOT NULL DEFAULT 0,
  successes     integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, actor_kind, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_trust_scores_family ON public.trust_scores(family_id, actor_kind);

-- ─── Emergency Operations Mode ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.emergency_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'general'
                  CHECK (kind IN ('medical','missing_person','severe_weather','natural_disaster','vehicle_accident','general')),
  reason        text CHECK (char_length(reason) <= 1000),
  activated_by  uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  activated_at  timestamptz NOT NULL DEFAULT now(),
  ended_by      uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  ended_at      timestamptz,
  -- Which domains get elevated to 'allow' while active.
  elevated_domains text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emergency_sessions_active ON public.emergency_sessions(family_id, ended_at) WHERE ended_at IS NULL;

-- ─── Trust audit log (explainability + complete trail) ──────────────────────
CREATE TABLE IF NOT EXISTS public.trust_audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  actor_kind    text NOT NULL DEFAULT 'ai_agent',
  actor_id      text,                                  -- member uuid or agent name
  domain        text,
  capability    text,
  decision      text NOT NULL CHECK (decision IN ('allow','deny','require_approval','auto_approve','executed','approved','rejected','emergency_override')),
  reason        text,                                  -- human-readable explanation
  policy_id     uuid REFERENCES public.trust_policies(id) ON DELETE SET NULL,
  confidence    numeric(4,3),
  approval_id   uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  device        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trust_audit_family ON public.trust_audit_logs(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_audit_domain ON public.trust_audit_logs(family_id, domain);

-- ─── updated_at triggers ────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trust_policies','permission_grants','trust_delegations','approval_requests','trust_scores','emergency_sessions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t, t);
    END IF;
  END LOOP;
END $$;

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.trust_policies     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_grants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trust_delegations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trust_scores       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emergency_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trust_audit_logs   ENABLE ROW LEVEL SECURITY;

-- Helper predicates inline. Members of the family can read; managers (parent/adult) write.
-- trust_policies
CREATE POLICY "trust_policies_read" ON public.trust_policies FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_policies.family_id AND fm.user_id = auth.uid() AND fm.is_active));
CREATE POLICY "trust_policies_write" ON public.trust_policies FOR ALL USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_policies.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_policies.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active));

-- permission_grants
CREATE POLICY "permission_grants_read" ON public.permission_grants FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = permission_grants.family_id AND fm.user_id = auth.uid() AND fm.is_active));
CREATE POLICY "permission_grants_write" ON public.permission_grants FOR ALL USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = permission_grants.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = permission_grants.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active));

-- trust_delegations
CREATE POLICY "trust_delegations_read" ON public.trust_delegations FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_delegations.family_id AND fm.user_id = auth.uid() AND fm.is_active));
CREATE POLICY "trust_delegations_write" ON public.trust_delegations FOR ALL USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_delegations.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_delegations.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active));

-- approval_requests: members read; managers decide; anyone in family can be a requester (insert).
CREATE POLICY "approval_requests_read" ON public.approval_requests FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = approval_requests.family_id AND fm.user_id = auth.uid() AND fm.is_active));
CREATE POLICY "approval_requests_insert" ON public.approval_requests FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = approval_requests.family_id AND fm.user_id = auth.uid() AND fm.is_active));
CREATE POLICY "approval_requests_update" ON public.approval_requests FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = approval_requests.family_id AND fm.user_id = auth.uid() AND fm.is_active));

-- trust_scores: read by members, write by managers.
CREATE POLICY "trust_scores_read" ON public.trust_scores FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_scores.family_id AND fm.user_id = auth.uid() AND fm.is_active));
CREATE POLICY "trust_scores_write" ON public.trust_scores FOR ALL USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_scores.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_scores.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active));

-- emergency_sessions: members read; managers activate/end.
CREATE POLICY "emergency_sessions_read" ON public.emergency_sessions FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = emergency_sessions.family_id AND fm.user_id = auth.uid() AND fm.is_active));
CREATE POLICY "emergency_sessions_write" ON public.emergency_sessions FOR ALL USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = emergency_sessions.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = emergency_sessions.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active));

-- trust_audit_logs: read by members, insert by family members (append-only — no update/delete policy).
CREATE POLICY "trust_audit_read" ON public.trust_audit_logs FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_audit_logs.family_id AND fm.user_id = auth.uid() AND fm.is_active));
CREATE POLICY "trust_audit_insert" ON public.trust_audit_logs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_audit_logs.family_id AND fm.user_id = auth.uid() AND fm.is_active));

-- ─── Realtime ───────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.trust_policies;
ALTER PUBLICATION supabase_realtime ADD TABLE public.permission_grants;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trust_delegations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.approval_requests;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trust_scores;
ALTER PUBLICATION supabase_realtime ADD TABLE public.emergency_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trust_audit_logs;
