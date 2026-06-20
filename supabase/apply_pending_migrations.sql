-- ============================================================
-- FamilyOS :: pending migrations bundle
-- Paste this whole file into the Supabase SQL Editor (or run via psql).
-- Idempotent: safe to run more than once. Assumes base migrations
-- 0001–0009 are already applied (the app's existing tables).
-- Includes: 0008 super admin seed, 0010 blog, 0011 public_stats, 0012 support_tickets.
-- ============================================================


-- ─────────────────────────────────────────────────────────
-- migration: 0008_super_admins
-- ─────────────────────────────────────────────────────────
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


-- ─────────────────────────────────────────────────────────
-- migration: 0010_blog_posts
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0010: Blog posts (CMS content moved into Supabase)
-- Replaces the hardcoded lib/blog/posts.ts dataset with a real
-- table. Public marketing /blog routes read published posts via
-- RLS (anon + authenticated SELECT where published = true).
-- Writes are service-role only (no write policy → RLS denies).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.blog_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  title           text NOT NULL,
  excerpt         text NOT NULL DEFAULT '',
  author          text NOT NULL DEFAULT 'The FamilyOS Team',
  published_at    date NOT NULL DEFAULT current_date,
  reading_minutes integer NOT NULL DEFAULT 5,
  tags            text[] NOT NULL DEFAULT '{}',
  category        text NOT NULL,
  featured        boolean NOT NULL DEFAULT false,
  accent_color    text,
  body            jsonb NOT NULL DEFAULT '[]'::jsonb,
  published       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published ON public.blog_posts (published, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON public.blog_posts (category);

-- keep updated_at fresh (reuses the shared trigger fn from 0003)
DROP TRIGGER IF EXISTS trg_blog_posts_updated_at ON public.blog_posts;
CREATE TRIGGER trg_blog_posts_updated_at
  BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: published posts are world-readable; writes are service-role only ──
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read published blog posts" ON public.blog_posts;
CREATE POLICY "Anyone can read published blog posts" ON public.blog_posts
  FOR SELECT TO anon, authenticated
  USING (published = true);

GRANT SELECT ON public.blog_posts TO anon, authenticated;

-- ── Seed the existing 11 posts (idempotent on slug) ──
INSERT INTO public.blog_posts (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color, body)
VALUES
  (
    'an-ai-chief-of-staff-for-your-home',
    'The AI Family Assistant: A New Way to Stay Ahead of Everything',
    'From school emails to soccer practice, see how AI can help your family stay organized, stress-free, and always one step ahead.',
    'Jessica Miller', '2024-05-12', 6, ARRAY['ai','product'], 'AI & Technology', true, '#7c5dff',
    $json$[
      {"type":"p","text":"Chatbots answer questions. A chief of staff gets things done. That distinction is the whole idea behind the FamilyOS assistant."},
      {"type":"h2","text":"From words to records"},
      {"type":"p","text":"Ask it to add soccer every Tuesday and it creates the recurring event. Ask it to plan dinners and build a grocery list, and it writes real rows into your family's database."}
    ]$json$::jsonb
  ),
  (
    'sync-family-schedule',
    'How to Sync Your Family''s Schedule (Without the Chaos)',
    'A practical guide to keeping everyone on the same page — from soccer practice to dentist appointments.',
    'The FamilyOS Team', '2024-05-10', 5, ARRAY['organization'], 'Organization', false, '#3b82f6',
    $json$[{"type":"p","text":"Every household runs on a hidden layer of coordination. Here's how to make it visible and shared."}]$json$::jsonb
  ),
  (
    'last-day-school-checklist',
    'Last-Day-of-School Checklist: Don''t Miss a Thing',
    'Return the library books, pick up art projects, say goodbye to teachers — a complete end-of-year checklist.',
    'The FamilyOS Team', '2024-05-09', 4, ARRAY['school'], 'School & Activities', false, '#10b981',
    $json$[{"type":"p","text":"The last week of school is a whirlwind. Here's how to get through it without forgetting anything."}]$json$::jsonb
  ),
  (
    'healthy-family-habits',
    'Healthy Family Habits That Stick (Even on Busy Weeks)',
    'Small rituals that make a big difference — and how to actually maintain them when life gets hectic.',
    'The FamilyOS Team', '2024-05-07', 6, ARRAY['wellness'], 'Wellness', false, '#f59e0b',
    $json$[{"type":"p","text":"The habits that stick are the ones that require the least willpower."}]$json$::jsonb
  ),
  (
    'family-budget-basics',
    'Budgeting as a Family: 5 Simple Steps to Get Started',
    'Money conversations don''t have to be stressful. Here''s a framework that actually works for busy families.',
    'The FamilyOS Team', '2024-05-04', 5, ARRAY['finances'], 'Family Finances', false, '#ec4899',
    $json$[{"type":"p","text":"Starting a family budget feels overwhelming. Break it into five simple steps."}]$json$::jsonb
  ),
  (
    'ai-family-life',
    '5 Ways AI Can Make Family Life So Much Easier',
    'From meal planning to homework help, AI is quietly transforming how modern families operate.',
    'The FamilyOS Team', '2024-05-02', 6, ARRAY['ai'], 'AI & Technology', false, '#7c5dff',
    $json$[{"type":"p","text":"AI isn't just for tech companies. Here are five practical ways it's changing family life."}]$json$::jsonb
  ),
  (
    'quality-time',
    'How to Create More Quality Time (Without More Time)',
    'The secret isn''t finding more hours. It''s making the hours you have count.',
    'The FamilyOS Team', '2024-04-30', 6, ARRAY['parenting','wellness'], 'Parenting', false, '#f97316',
    $json$[{"type":"p","text":"Most parents already know how precious time with their kids is. The challenge is protecting it."}]$json$::jsonb
  ),
  (
    'taming-the-family-mental-load',
    'Taming the family mental load',
    'The invisible work of running a household is real. Here''s how to share it.',
    'The FamilyOS Team', '2026-05-02', 4, ARRAY['organization','parenting'], 'Parenting', false, NULL,
    $json$[{"type":"p","text":"Every household runs on a hidden layer of coordination."}]$json$::jsonb
  ),
  (
    'meal-planning-that-actually-sticks',
    'Meal planning that actually sticks',
    'A simple weekly rhythm — and how to make the grocery list build itself.',
    'The FamilyOS Team', '2026-05-18', 3, ARRAY['meals','routines'], 'Organization', false, NULL,
    $json$[{"type":"p","text":"Most meal-planning systems fail because they're too much work."}]$json$::jsonb
  )
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Done! Blog content now lives in Supabase. The /blog routes read
-- from public.blog_posts; lib/blog/posts.ts is now a data-access layer.
-- ============================================================


-- ─────────────────────────────────────────────────────────
-- migration: 0011_public_stats
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0011: public_stats() — safe aggregate counts for the
-- public marketing site. Returns ONLY non-identifying totals so the
-- landing/pricing pages can show real numbers instead of a hardcoded
-- "10,000+ families". SECURITY DEFINER so anon can read aggregates
-- without any row-level access to the underlying tables.
-- ============================================================

CREATE OR REPLACE FUNCTION public.public_stats()
RETURNS TABLE (families bigint, members bigint, tasks_completed bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM public.families),
    (SELECT count(*) FROM public.family_members WHERE is_active = true),
    (SELECT count(*) FROM public.chore_assignments WHERE status IN ('approved','done'));
$$;

REVOKE ALL ON FUNCTION public.public_stats() FROM public;
GRANT EXECUTE ON FUNCTION public.public_stats() TO anon, authenticated;

-- ============================================================
-- Done! Marketing pages call supabase.rpc('public_stats') to render
-- real family/member counts.
-- ============================================================


-- ─────────────────────────────────────────────────────────
-- migration: 0012_support_tickets
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0012: Support tickets
-- Backs the Admin Dashboard "Support Overview" panel with real data.
-- Rows are created server-side from the public contact form (service
-- role) and read only by the super admin via the service-role client.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL DEFAULT '',
  email      text NOT NULL,
  subject    text NOT NULL DEFAULT '',
  message    text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  source     text NOT NULL DEFAULT 'contact',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON public.support_tickets;
CREATE TRIGGER trg_support_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS on with NO policies: no client session can read or write directly.
-- Inserts come from the contact API via the service-role client, and the
-- super admin reads via the service-role client in the admin console — both
-- bypass RLS. This keeps support messages off-limits to ordinary users.
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Contact-form submissions now land in support_tickets.
-- ============================================================



-- ─────────────────────────────────────────────────────────
-- migration: 0014_family_os  (Family AI Operating System modules)
-- ─────────────────────────────────────────────────────────
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
