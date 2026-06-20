-- ============================================================
-- FamilyOS :: reconcile_production.sql
-- Applies ONLY the objects that drifted out of production:
--   1. documents.asset_id column        (from migration 0007)
--   2. super_admins + is_super_admin()   (migration 0008)
--   3. 13 Family OS tables               (migration 0014)
--   4. 3 admin console tables            (migration 0015)
-- Fully idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF
-- EXISTS) — safe to run on production once in the Supabase SQL Editor.
-- Assumes base migrations 0001-0006, 0009 are already applied (they are:
-- the live app depends on them).
-- ============================================================

-- 1) Missing column ------------------------------------------------------
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES public.home_assets(id) ON DELETE CASCADE;

-- 2) Super admin table + function ---------------------------------------
-- ============================================================
-- Migration 0008: Super Administrator (site-wide)
-- A super admin is identified by email, independent of family
-- membership — they oversee the whole site, not a single household.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.super_admins (
  email      text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS is enabled with NO policies on purpose: no client (including the
-- super admin's own session) may SELECT/INSERT/UPDATE/DELETE this table
-- directly. The only way in is the SECURITY DEFINER function below,
-- which only ever reveals a true/false answer about the caller.
ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.super_admins
    WHERE email = lower(coalesce(auth.jwt()->>'email', ''))
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

INSERT INTO public.super_admins (email)
VALUES ('daniel.hughen@gmail.com')
ON CONFLICT (email) DO NOTHING;

-- 3) Family OS module tables (0014) -----------------------------------
-- ============================================================
-- Migration 0014: Family AI Operating System modules
-- Adds the tables that power the new Family OS surfaces:
--   Digital Twin, Routines, AI Recommendations, Stress Prediction,
--   Life Automation, Knowledge Graph, Emergency Hub, Memory Brain.
--
-- Existing tables already cover Finance (financial_accounts, transactions,
-- budgets, bills, savings_goals), Operations (chores, calendar_events,
-- grocery_*), Health (medical_profiles, medications, appointments),
-- School (school_classes, grades, school_events), Sports (teams,
-- game_results, sports_events) and AI threads (ai_conversations,
-- ai_messages) — those modules compose what is already there.
--
-- Every new table follows the house conventions: family_id FK with
-- ON DELETE CASCADE, created_at/updated_at, created_by, a status column,
-- a metadata jsonb, an updated_at trigger, an index on family_id, and an
-- RLS policy gated on is_family_member(family_id).
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ── Family Routines ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_routines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  category text,
  time_of_day text,
  days_of_week int[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ── Digital Twin profiles (one living model per member) ─────
CREATE TABLE IF NOT EXISTS family_digital_twin_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{}',
  responsibilities jsonb NOT NULL DEFAULT '[]',
  strengths text,
  notes text,
  ai_insights text,
  stress_baseline int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, member_id)
);

-- ── AI recommendations (next-best-action feed) ─────────────
CREATE TABLE IF NOT EXISTS family_ai_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  category text NOT NULL DEFAULT 'general',
  title text NOT NULL,
  body text,
  priority text NOT NULL DEFAULT 'medium',
  cta_href text,
  source text,
  status text NOT NULL DEFAULT 'pending', -- pending | accepted | dismissed | done
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Stress prediction inputs + outputs ─────────────────────
CREATE TABLE IF NOT EXISTS family_stress_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  signal_type text NOT NULL,
  weight numeric(6,2) NOT NULL DEFAULT 1,
  source text,
  occurred_on date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_stress_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  for_date date NOT NULL DEFAULT CURRENT_DATE,
  score int NOT NULL DEFAULT 0,
  level text NOT NULL DEFAULT 'low',
  factors jsonb NOT NULL DEFAULT '[]',
  suggestions jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Life automation rules + run log ────────────────────────
CREATE TABLE IF NOT EXISTS family_automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_type text NOT NULL,
  trigger_config jsonb NOT NULL DEFAULT '{}',
  action_type text NOT NULL,
  action_config jsonb NOT NULL DEFAULT '{}',
  is_enabled boolean NOT NULL DEFAULT true,
  requires_approval boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES family_automation_rules(id) ON DELETE CASCADE,
  trigger_type text,
  status text NOT NULL DEFAULT 'pending', -- pending | approved | executed | skipped | failed
  summary text,
  result jsonb NOT NULL DEFAULT '{}',
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Knowledge graph (nodes + edges) ────────────────────────
CREATE TABLE IF NOT EXISTS family_knowledge_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  node_type text NOT NULL,
  label text NOT NULL,
  ref_table text,
  ref_id uuid,
  weight numeric(6,2) NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_knowledge_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES family_knowledge_nodes(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES family_knowledge_nodes(id) ON DELETE CASCADE,
  relation text NOT NULL DEFAULT 'related_to',
  weight numeric(6,2) NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Emergency hub ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_emergency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  name text NOT NULL,
  relationship text,
  phone text,
  alt_phone text,
  email text,
  address text,
  is_primary boolean NOT NULL DEFAULT false,
  can_pickup boolean NOT NULL DEFAULT false,
  priority int NOT NULL DEFAULT 100,
  notes text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_emergency_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title text NOT NULL,
  plan_type text,
  content text,
  safe_location text,
  instructions text,
  is_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Memory brain ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  title text NOT NULL,
  body text,
  kind text NOT NULL DEFAULT 'journal', -- photo | quote | trip | achievement | journal | milestone
  memory_date date NOT NULL DEFAULT CURRENT_DATE,
  media_path text,
  tags text[] NOT NULL DEFAULT '{}',
  is_favorite boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS family_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  milestone_date date NOT NULL DEFAULT CURRENT_DATE,
  category text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Indexes, updated_at triggers, RLS for every new table
-- ============================================================
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'family_routines', 'family_digital_twin_profiles', 'family_ai_recommendations',
    'family_stress_signals', 'family_stress_predictions',
    'family_automation_rules', 'family_automation_runs',
    'family_knowledge_nodes', 'family_knowledge_edges',
    'family_emergency_contacts', 'family_emergency_plans',
    'family_memories', 'family_milestones'
  ])
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%1$s_family ON %1$I(family_id)', tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS set_%1$s_updated ON %1$I', tbl);
    EXECUTE format('CREATE TRIGGER set_%1$s_updated BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', tbl);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Members can manage %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Members can manage %1$s" ON %1$I FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id))',
      tbl
    );
  END LOOP;
END $$;

-- Extra hot-path indexes
CREATE INDEX IF NOT EXISTS idx_family_routines_member ON family_routines(family_id, member_id);
CREATE INDEX IF NOT EXISTS idx_family_ai_recommendations_status ON family_ai_recommendations(family_id, status);
CREATE INDEX IF NOT EXISTS idx_family_stress_signals_date ON family_stress_signals(family_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_family_stress_predictions_date ON family_stress_predictions(family_id, for_date);
CREATE INDEX IF NOT EXISTS idx_family_automation_runs_rule ON family_automation_runs(family_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_family_knowledge_edges_src ON family_knowledge_edges(family_id, source_id);
CREATE INDEX IF NOT EXISTS idx_family_knowledge_edges_tgt ON family_knowledge_edges(family_id, target_id);
CREATE INDEX IF NOT EXISTS idx_family_memories_date ON family_memories(family_id, memory_date);
CREATE INDEX IF NOT EXISTS idx_family_milestones_date ON family_milestones(family_id, milestone_date);

-- ============================================================
-- Done — 13 new tables, indexed, triggered, RLS-isolated.
-- ============================================================

-- 4) Admin console tables (0015) --------------------------------------
-- ============================================================
-- Migration 0015: Admin console support tables
--   app_settings        — persisted platform/system settings (key/value)
--   system_backups      — logged backup events + their metrics
--   admin_integrations  — third-party integration registry + status
--
-- These are SITE-ADMIN tables: RLS is enabled with NO policies, so no client
-- session can read/write them directly. The admin console reaches them only
-- through the service-role client (gated by the super-admin check in
-- admin/layout.tsx) — exactly like support_tickets (migration 0012).
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ── Settings (key/value) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- ── Backup events ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.system_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'full',          -- full | incremental
  status text NOT NULL DEFAULT 'completed',    -- completed | warning | failed | running
  size_bytes bigint NOT NULL DEFAULT 0,
  location text,
  row_counts jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_system_backups_created ON public.system_backups(created_at DESC);
ALTER TABLE public.system_backups ENABLE ROW LEVEL SECURITY;

-- ── Integration registry ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'Other',
  status text NOT NULL DEFAULT 'available',     -- connected | issue | disconnected | available
  config jsonb NOT NULL DEFAULT '{}',
  last_sync_at timestamptz,
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS set_admin_integrations_updated ON public.admin_integrations;
CREATE TRIGGER set_admin_integrations_updated BEFORE UPDATE ON public.admin_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE public.admin_integrations ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done — 3 admin-only tables (service-role access only).
-- ============================================================

-- ============================================================
-- Done — production reconciled.
-- ============================================================
