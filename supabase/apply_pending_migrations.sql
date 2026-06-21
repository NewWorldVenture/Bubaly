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
-- migration: 0016_dashboard_preference
-- ─────────────────────────────────────────────────────────
-- Per-user default dashboard preference.
-- 'personal' = the member's role-specific dashboard (the default).
-- 'family'   = the shared Family Dashboard / Command Center overview.

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS default_dashboard text NOT NULL DEFAULT 'personal'
    CHECK (default_dashboard IN ('personal', 'family'));


-- ─────────────────────────────────────────────────────────
-- migration: 0017_conversation_participants
-- ─────────────────────────────────────────────────────────
-- Roster of conversation participants by family_members.id, so members without
-- a login (kids/guests) are first-class participants alongside account holders.

ALTER TABLE public.family_conversations
  ADD COLUMN IF NOT EXISTS participant_ids uuid[] NOT NULL DEFAULT '{}';



-- ============================================================
-- Marketing module (migrations 0013, 0020, 0021) — appended for the
-- consolidated bundle. All idempotent (IF NOT EXISTS).
-- ============================================================
-- ============================================================
-- Migration 0013: Admin Marketing module
-- Backs /admin/marketing. Every table follows the same security model as
-- super_admins / support_tickets: RLS is ENABLED with NO policies, so no
-- client session can read or write directly. All access happens through the
-- service-role client in the super-admin-gated admin console (which bypasses
-- RLS). This keeps marketing data fully admin-only.
--
-- "Customers" in FamilyOS are existing families/subscriptions/contacts — those
-- are NOT duplicated here; the marketing customer view is derived at read time
-- from the existing tables. These tables store marketing-specific objects only.
-- ============================================================

-- ---------- Segments ----------
CREATE TABLE IF NOT EXISTS public.marketing_segments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  kind        text NOT NULL DEFAULT 'dynamic' CHECK (kind IN ('dynamic', 'static')),
  -- Dynamic segments store their rule; static segments store an explicit list.
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  member_keys text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_segments_status ON public.marketing_segments (status, created_at DESC);

-- ---------- Campaigns ----------
CREATE TABLE IF NOT EXISTS public.marketing_campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  objective    text,
  channel      text NOT NULL DEFAULT 'email'
                 CHECK (channel IN ('email','sms','social','ads','seo','aeo','content','referral','multi')),
  type         text NOT NULL DEFAULT 'campaign'
                 CHECK (type IN ('campaign','launch','re_engagement','win_back','referral','fundraising','retargeting')),
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','scheduled','active','paused','completed','archived')),
  segment_id   uuid REFERENCES public.marketing_segments(id) ON DELETE SET NULL,
  budget_cents integer NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  starts_at    timestamptz,
  ends_at      timestamptz,
  notes        text,
  kpis         jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_campaigns_status ON public.marketing_campaigns (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_campaigns_channel ON public.marketing_campaigns (channel);

-- ---------- Email campaigns ----------
CREATE TABLE IF NOT EXISTS public.marketing_email_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  segment_id    uuid REFERENCES public.marketing_segments(id) ON DELETE SET NULL,
  subject       text NOT NULL DEFAULT '',
  preview_text  text,
  body_html     text NOT NULL DEFAULT '',
  from_name     text,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','sending','sent','failed')),
  scheduled_at  timestamptz,
  sent_at       timestamptz,
  recipients    integer NOT NULL DEFAULT 0,
  opens         integer NOT NULL DEFAULT 0,
  clicks        integer NOT NULL DEFAULT 0,
  bounces       integer NOT NULL DEFAULT 0,
  unsubscribes  integer NOT NULL DEFAULT 0,
  provider_ref  text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_email_campaign ON public.marketing_email_campaigns (campaign_id);
CREATE INDEX IF NOT EXISTS idx_mkt_email_status ON public.marketing_email_campaigns (status, created_at DESC);

-- ---------- Content items (calendar + briefs) ----------
CREATE TABLE IF NOT EXISTS public.marketing_content_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  title        text NOT NULL,
  kind         text NOT NULL DEFAULT 'blog'
                 CHECK (kind IN ('blog','landing','social','email','ad','seo_brief','aeo_brief')),
  channel      text,
  brief        text,
  body         text,
  status       text NOT NULL DEFAULT 'idea'
                 CHECK (status IN ('idea','brief','drafting','review','approved','published')),
  publish_at   timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_content_status ON public.marketing_content_items (status, publish_at);

-- ---------- SEO pages ----------
CREATE TABLE IF NOT EXISTS public.marketing_seo_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path             text NOT NULL UNIQUE,
  title            text,
  meta_description text,
  issues           jsonb NOT NULL DEFAULT '[]'::jsonb,
  score            integer CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','noindex','archived')),
  last_audited_at  timestamptz,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------- SEO keywords (first-party tracking; AI ideas flagged in metadata) ----------
CREATE TABLE IF NOT EXISTS public.marketing_seo_keywords (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword     text NOT NULL,
  intent      text CHECK (intent IS NULL OR intent IN ('informational','navigational','commercial','transactional')),
  target_path text,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai_suggestion','search_console')),
  status      text NOT NULL DEFAULT 'tracking' CHECK (status IN ('idea','tracking','won','dropped')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (keyword, target_path)
);
CREATE INDEX IF NOT EXISTS idx_mkt_seo_keywords_status ON public.marketing_seo_keywords (status);

-- ---------- AEO questions/answers ----------
CREATE TABLE IF NOT EXISTS public.marketing_aeo_questions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question       text NOT NULL,
  answer         text,
  entity         text,
  source_path    text,
  pattern        text CHECK (pattern IS NULL OR pattern IN ('what_is','how_to','best_x_for_y','comparison','faq','local')),
  status         text NOT NULL DEFAULT 'opportunity'
                   CHECK (status IN ('opportunity','drafting','answered','published')),
  clarity_score  integer CHECK (clarity_score IS NULL OR (clarity_score BETWEEN 0 AND 100)),
  last_reviewed  timestamptz,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_aeo_status ON public.marketing_aeo_questions (status);

-- ---------- Settings (key/value) ----------
CREATE TABLE IF NOT EXISTS public.marketing_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Marketing audit log ----------
CREATE TABLE IF NOT EXISTS public.marketing_audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email text,
  action      text NOT NULL,
  resource    text NOT NULL,
  resource_id text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_audit_created ON public.marketing_audit_logs (created_at DESC);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'marketing_segments','marketing_campaigns','marketing_email_campaigns',
    'marketing_content_items','marketing_seo_pages','marketing_seo_keywords',
    'marketing_aeo_questions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_set_updated_at ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- RLS: enabled, NO policies (service-role / admin console only) ----------
ALTER TABLE public.marketing_segments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaigns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_content_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_seo_pages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_seo_keywords    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_aeo_questions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_audit_logs      ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Admin Marketing tables created (admin-only via service role).
-- ============================================================

-- ============================================================
-- Migration 0014: Marketing channels & builders
-- SMS, social, ads, automation, funnels, landing pages, and forms.
-- Same security model as 0013: RLS ENABLED with NO policies — admin/service
-- role only. Multi-step structures (automation steps, funnel steps, form
-- fields) are stored as jsonb on the parent row.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_sms_campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  segment_id   uuid REFERENCES public.marketing_segments(id) ON DELETE SET NULL,
  message      text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','failed')),
  scheduled_at timestamptz,
  sent_at      timestamptz,
  recipients   integer NOT NULL DEFAULT 0,
  delivered    integer NOT NULL DEFAULT 0,
  replies      integer NOT NULL DEFAULT 0,
  opt_outs     integer NOT NULL DEFAULT 0,
  provider_ref text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_sms_status ON public.marketing_sms_campaigns (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.marketing_social_posts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  platform     text NOT NULL DEFAULT 'instagram'
                 CHECK (platform IN ('facebook','instagram','linkedin','tiktok','x','youtube')),
  content      text NOT NULL DEFAULT '',
  link         text,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published')),
  scheduled_at timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_social_status ON public.marketing_social_posts (status, scheduled_at);

CREATE TABLE IF NOT EXISTS public.marketing_ad_campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  platform     text NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta','google','linkedin','tiktok','x')),
  name         text NOT NULL,
  objective    text,
  budget_cents integer NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  spend_cents  integer NOT NULL DEFAULT 0 CHECK (spend_cents >= 0),
  impressions  integer NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  conversions  integer NOT NULL DEFAULT 0,
  utm          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','paused','completed')),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_ads_status ON public.marketing_ad_campaigns (status);

CREATE TABLE IF NOT EXISTS public.marketing_automation_workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  trigger     text NOT NULL DEFAULT 'customer_created',
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  run_count   integer NOT NULL DEFAULT 0,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketing_automation_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.marketing_automation_workflows(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'completed' CHECK (status IN ('running','completed','failed')),
  subject_key text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_runs_workflow ON public.marketing_automation_runs (workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.marketing_funnels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketing_landing_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL,
  headline    text,
  subhead     text,
  body        text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published   boolean NOT NULL DEFAULT false,
  views       integer NOT NULL DEFAULT 0,
  conversions integer NOT NULL DEFAULT 0,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketing_forms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  name        text NOT NULL,
  fields      jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketing_form_submissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id    uuid NOT NULL REFERENCES public.marketing_forms(id) ON DELETE CASCADE,
  email      text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  source     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_form_subs ON public.marketing_form_submissions (form_id, created_at DESC);

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'marketing_sms_campaigns','marketing_social_posts','marketing_ad_campaigns',
    'marketing_automation_workflows','marketing_funnels','marketing_landing_pages','marketing_forms'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_set_updated_at ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- RLS: enabled, NO policies (service-role / admin console only)
ALTER TABLE public.marketing_sms_campaigns        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_social_posts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_ad_campaigns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_automation_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_automation_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_funnels              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_landing_pages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_forms                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_form_submissions     ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Marketing channel + builder tables created.
-- ============================================================

-- ============================================================
-- Migration 0021: Marketing email suppressions
-- Honors unsubscribes, bounces, and spam complaints. Anyone in this table is
-- excluded from marketing sends. Same security model: RLS enabled, no policies
-- (admin/service-role only). The unsubscribe route writes here via the service
-- role; the Resend webhook adds bounces/complaints.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_suppressions (
  email       text PRIMARY KEY,
  reason      text NOT NULL DEFAULT 'unsubscribe'
                CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual')),
  campaign_id uuid REFERENCES public.marketing_email_campaigns(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.marketing_suppressions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Suppressed addresses are excluded from all marketing sends.
-- ============================================================


-- ============================================================
-- Weather saved locations (migration 0024) — appended to bundle. Idempotent.
-- ============================================================
-- ============================================================
-- Migration 0024: Weather saved locations
-- Per-family list of saved cities for the Weather feature. Live forecast data
-- comes from a real-time weather API in the browser; only the user's chosen
-- locations are persisted here. Family-scoped with the standard RLS model.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.weather_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  admin1      text,
  country     text,
  latitude    double precision NOT NULL,
  longitude   double precision NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Avoid duplicate saved cities within a family (rounded to ~11m).
  UNIQUE (family_id, latitude, longitude)
);

CREATE INDEX IF NOT EXISTS idx_weather_locations_family ON public.weather_locations (family_id, sort_order);

DROP TRIGGER IF EXISTS trg_weather_locations_updated_at ON public.weather_locations;
CREATE TRIGGER trg_weather_locations_updated_at
  BEFORE UPDATE ON public.weather_locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- RLS: family-scoped CRUD (matches 0004 pattern) ----------
ALTER TABLE public.weather_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS weather_locations_select ON public.weather_locations;
CREATE POLICY weather_locations_select ON public.weather_locations
  FOR SELECT USING (public.is_family_member(family_id));
DROP POLICY IF EXISTS weather_locations_insert ON public.weather_locations;
CREATE POLICY weather_locations_insert ON public.weather_locations
  FOR INSERT WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS weather_locations_update ON public.weather_locations;
CREATE POLICY weather_locations_update ON public.weather_locations
  FOR UPDATE USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS weather_locations_delete ON public.weather_locations;
CREATE POLICY weather_locations_delete ON public.weather_locations
  FOR DELETE USING (public.is_family_member(family_id));

-- ============================================================
-- Done! Families can save weather locations; forecasts are fetched live.
-- ============================================================


-- ============================================================
-- Repair grocery_lists / grocery_items RLS (migration 0025). Idempotent.
-- ============================================================
-- ============================================================
-- Migration 0025: Repair grocery_lists / grocery_items RLS
-- Symptom: creating a shopping list fails with "new row violates row-level
-- security policy for table grocery_lists". That happens when RLS is enabled on
-- the table but the family-scoped INSERT policy isn't present (e.g. a DB set up
-- from a partial bundle that ran the table alters but not 0004's policy block).
--
-- This re-asserts the standard family CRUD policies idempotently. It's a no-op
-- on a correctly-migrated database and a fix on one that's missing them.
-- ============================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['grocery_lists', 'grocery_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_select ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_select ON public.%1$I FOR SELECT USING (public.is_family_member(family_id))', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON public.%1$I FOR INSERT WITH CHECK (public.is_family_member(family_id))', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_update ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_update ON public.%1$I FOR UPDATE USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_delete ON public.%1$I FOR DELETE USING (public.is_family_member(family_id))', t);
  END LOOP;
END $$;

-- ============================================================
-- Done! Family members can create/read/update/delete their shopping lists.
-- ============================================================




-- ============================================================
-- FAMILY OS :: features 0026–0033 (appended)
-- Net-new modules: medications dose log, rides, reward redemptions,
-- trips, homework, signups/opportunities, care log, renewals.
-- All idempotent (CREATE TABLE IF NOT EXISTS / enum guards /
-- DROP POLICY IF EXISTS). Safe to run more than once.
-- ============================================================


-- ─────────────────────────────────────────────────────────
-- migration: 0026_medication_doses
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0026: Medication dose log (adherence tracking)
-- Backs the Medication Tracker. `medications` and
-- `medication_schedules` already exist (migration 0002); this adds a
-- per-dose log so adherence can be measured over time instead of only
-- tracking the last time a med was taken.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE dose_status AS ENUM ('taken', 'skipped', 'missed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.medication_doses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  medication_id uuid NOT NULL REFERENCES public.medications(id) ON DELETE CASCADE,
  schedule_id   uuid REFERENCES public.medication_schedules(id) ON DELETE SET NULL,
  member_id     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  -- The calendar day + scheduled time this dose belongs to. `scheduled_for`
  -- is the canonical slot; a (schedule_id, scheduled_for) pair is unique so a
  -- dose can be toggled idempotently from the UI.
  scheduled_for timestamptz NOT NULL,
  status        dose_status NOT NULL DEFAULT 'taken',
  taken_at      timestamptz,
  notes         text,
  logged_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_med_doses_family ON public.medication_doses(family_id);
CREATE INDEX IF NOT EXISTS idx_med_doses_med ON public.medication_doses(medication_id);
CREATE INDEX IF NOT EXISTS idx_med_doses_scheduled ON public.medication_doses(family_id, scheduled_for);
-- One row per scheduled slot so "mark taken/skip" is an idempotent upsert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_med_doses_slot
  ON public.medication_doses(schedule_id, scheduled_for)
  WHERE schedule_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.medication_doses;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.medication_doses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.medication_doses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage medication_doses" ON public.medication_doses;
CREATE POLICY "Members can manage medication_doses" ON public.medication_doses
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));


-- ─────────────────────────────────────────────────────────
-- migration: 0027_rides
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0027: Transportation / Carpool planner
-- Backs the Rides Planner (Top-50 complaint #17 "coordinating rides
-- → AI transportation planner"). Tracks who is driving whom, when, and
-- to/from where — with an optional link to a calendar event.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE ride_status AS ENUM ('planned', 'confirmed', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.rides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title            text NOT NULL,
  ride_date        date NOT NULL,
  pickup_time      time,
  dropoff_time     time,
  pickup_location  text,
  dropoff_location text,
  -- Driver is a family member (or null when a ride still needs one).
  driver_id        uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  -- Riders are family members; kept as an array so a ride is a single row.
  rider_ids        uuid[] NOT NULL DEFAULT '{}',
  status           ride_status NOT NULL DEFAULT 'planned',
  notes            text,
  event_id         uuid REFERENCES public.calendar_events(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_family ON public.rides(family_id);
CREATE INDEX IF NOT EXISTS idx_rides_date ON public.rides(family_id, ride_date);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON public.rides(driver_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.rides;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage rides" ON public.rides;
CREATE POLICY "Members can manage rides" ON public.rides
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));


-- ─────────────────────────────────────────────────────────
-- migration: 0028_reward_redemptions
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0028: Reward redemptions (allowance / points ledger)
-- Backs the Rewards & Allowance center (Top-50 complaints #7 "kids don't
-- do chores → gamification" and #21 "parents overloaded"). The existing
-- `rewards` table (migration 0002) modelled a one-shot redeemable; this
-- turns rewards into a reusable catalog and logs each redemption as a
-- request that a parent approves, so points balances have real history.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE redemption_status AS ENUM ('requested', 'approved', 'fulfilled', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.reward_redemptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  reward_id    uuid REFERENCES public.rewards(id) ON DELETE SET NULL,
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  -- Snapshot of the reward's title + cost at redemption time so history
  -- survives the reward being edited or deleted.
  reward_title text NOT NULL,
  cost_points  integer NOT NULL DEFAULT 0,
  status       redemption_status NOT NULL DEFAULT 'requested',
  note         text,
  decided_by   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_redemptions_family ON public.reward_redemptions(family_id);
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_member ON public.reward_redemptions(member_id);
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_status ON public.reward_redemptions(family_id, status);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.reward_redemptions;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.reward_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.reward_redemptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage reward_redemptions" ON public.reward_redemptions;
CREATE POLICY "Members can manage reward_redemptions" ON public.reward_redemptions
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));


-- ─────────────────────────────────────────────────────────
-- migration: 0029_trips
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0029: Travel / Trip planner
-- Backs the Trip Planner (Top-50 complaint #18 "vacation planning
-- difficult → AI family trip planner"). A trip plus a checklist of items
-- (packing, to-dos, reservations, documents) the family works through.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE trip_status AS ENUM ('planning', 'booked', 'active', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trip_item_kind AS ENUM ('packing', 'todo', 'reservation', 'document');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.trips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name         text NOT NULL,
  destination  text,
  start_date   date,
  end_date     date,
  status       trip_status NOT NULL DEFAULT 'planning',
  traveler_ids uuid[] NOT NULL DEFAULT '{}',
  notes        text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trips_family ON public.trips(family_id);
CREATE INDEX IF NOT EXISTS idx_trips_dates ON public.trips(family_id, start_date);

CREATE TABLE IF NOT EXISTS public.trip_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  trip_id     uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  kind        trip_item_kind NOT NULL DEFAULT 'packing',
  label       text NOT NULL,
  details     text,
  assignee_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  is_done     boolean NOT NULL DEFAULT false,
  due_at      timestamptz,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_items_family ON public.trip_items(family_id);
CREATE INDEX IF NOT EXISTS idx_trip_items_trip ON public.trip_items(trip_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.trips;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_set_updated_at ON public.trip_items;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.trip_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
-- Explicit per-table statements (no DO/format loop): the dollar-quoted
-- format() placeholders confuse some SQL clients' statement parsers.
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage trips" ON public.trips;
CREATE POLICY "Members can manage trips" ON public.trips
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.trip_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage trip_items" ON public.trip_items;
CREATE POLICY "Members can manage trip_items" ON public.trip_items
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));


-- ─────────────────────────────────────────────────────────
-- migration: 0030_homework
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0030: Homework tracker
-- Backs the Homework Tracker (Top-50 complaint #16 "kids miss homework
-- → AI student assistant"). Per-student assignments with subject, due
-- date, and a simple status workflow.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE homework_status AS ENUM ('assigned', 'in_progress', 'done', 'submitted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.homework_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  subject     text,
  title       text NOT NULL,
  details     text,
  due_at      timestamptz,
  status      homework_status NOT NULL DEFAULT 'assigned',
  completed_at timestamptz,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_homework_family ON public.homework_assignments(family_id);
CREATE INDEX IF NOT EXISTS idx_homework_member ON public.homework_assignments(member_id);
CREATE INDEX IF NOT EXISTS idx_homework_due ON public.homework_assignments(family_id, due_at);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.homework_assignments;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.homework_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.homework_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage homework_assignments" ON public.homework_assignments;
CREATE POLICY "Members can manage homework_assignments" ON public.homework_assignments
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));


-- ─────────────────────────────────────────────────────────
-- migration: 0031_opportunities
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0031: Registrations & Signups tracker
-- Backs the Signups tracker (Top-50 complaints #27 "school
-- registrations missed → AI registration monitoring" and #28 "camp
-- signups fill up → AI opportunity alerts"). Time-boxed opportunities
-- (camp/school/sports/activity registrations) with a deadline and a
-- simple status workflow so nothing fills up or closes unnoticed.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE opportunity_status AS ENUM ('interested', 'registered', 'waitlisted', 'passed', 'missed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.opportunities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title       text NOT NULL,
  category    text,                 -- camp / school / sports / activity / class / other
  url         text,
  cost        numeric(10,2),
  opens_at    date,                 -- registration opens
  deadline    date,                 -- registration closes
  status      opportunity_status NOT NULL DEFAULT 'interested',
  notes       text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunities_family ON public.opportunities(family_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_deadline ON public.opportunities(family_id, deadline);
CREATE INDEX IF NOT EXISTS idx_opportunities_member ON public.opportunities(member_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.opportunities;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.opportunities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage opportunities" ON public.opportunities;
CREATE POLICY "Members can manage opportunities" ON public.opportunities
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));


-- ─────────────────────────────────────────────────────────
-- migration: 0032_care_log
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0032: Caregiver / Elder care log
-- Backs the Care Log (Top-50 complaint #25 "elder care difficult → AI
-- caregiver dashboard"). A timeline of check-ins, visits, calls, and
-- well-being notes for a family member who needs coordinated care, so
-- the whole family can see who last checked in and how they're doing.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE care_log_type AS ENUM ('check_in', 'visit', 'call', 'meal', 'medication', 'appointment', 'incident', 'note');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.care_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  -- The person being cared for.
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  log_type     care_log_type NOT NULL DEFAULT 'check_in',
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  -- Optional 1–5 well-being rating recorded at the time.
  wellbeing    smallint CHECK (wellbeing BETWEEN 1 AND 5),
  note         text,
  -- The family member who performed/recorded the care.
  logged_by    uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_care_log_family ON public.care_log(family_id);
CREATE INDEX IF NOT EXISTS idx_care_log_member ON public.care_log(family_id, member_id, occurred_at DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.care_log;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.care_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.care_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage care_log" ON public.care_log;
CREATE POLICY "Members can manage care_log" ON public.care_log
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));


-- ─────────────────────────────────────────────────────────
-- migration: 0033_renewals
-- ─────────────────────────────────────────────────────────
-- ============================================================
-- Migration 0033: Renewals & Expirations tracker
-- Backs the Renewals tracker (Top-50 complaints #30 "household documents
-- expire → AI expiration management" and #31 "appliance warranties
-- forgotten → AI warranty manager"). Tracks anything that expires and
-- needs renewing — IDs, licenses, registrations, warranties, insurance,
-- subscriptions — each with its own reminder lead time.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE renewal_status AS ENUM ('active', 'renewed', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.renewals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title         text NOT NULL,
  category      text,                 -- id / passport / license / registration / warranty / insurance / subscription / other
  expires_at    date NOT NULL,
  -- How many days before expiry this should start warning.
  reminder_days integer NOT NULL DEFAULT 30,
  cost          numeric(10,2),
  url           text,
  status        renewal_status NOT NULL DEFAULT 'active',
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_renewals_family ON public.renewals(family_id);
CREATE INDEX IF NOT EXISTS idx_renewals_expiry ON public.renewals(family_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_renewals_member ON public.renewals(member_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.renewals;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.renewals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.renewals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage renewals" ON public.renewals;
CREATE POLICY "Members can manage renewals" ON public.renewals
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));


-- ============================================================
-- Migration 0034: Social Command Center
-- ============================================================
-- FamilyOS :: 0034 social media command center
-- Persistence for the Social Media Command Center: connected accounts + encrypted
-- tokens, the unified feed, drafts/variants/targets, media library, scheduling,
-- the publish job/result pipeline, comments/messages (inbox), analytics snapshots,
-- AI generation history, campaigns, calendar items, webhook intake, provider error
-- + usage tracking, audit logs, per-family settings, and granular social access.
--
-- Security model:
--   * Every household table is family-scoped via public.is_family_member(family_id)
--     — the same hard isolation boundary used everywhere else in FamilyOS. No row
--     ever crosses a family.
--   * social_account_tokens stores ONLY ciphertext (encrypt with lib/social/crypto
--     / the existing SYNC_TOKEN_KEY AES-256-GCM helper). RLS leaves it with NO
--     policy, so only the service-role client can ever read tokens. The browser
--     physically cannot.
--   * social_providers is global read-only reference data, mirrored from
--     lib/social/capabilities.ts.
--   * Granular in-family roles (owner…read_only) are enforced in server actions and,
--     for the publish-sensitive tables, in RLS via public.social_has_permission().

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
do $$ begin
  create type public.social_platform as enum
    ('x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_account_status as enum
    ('pending','connected','error','expired','disconnected','revoked','requires_setup');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_post_kind as enum
    ('text','image','video','audio','short','carousel','thread','poll','link','announcement');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_post_status as enum
    ('draft','scheduled','publishing','published','partially_published','failed','canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_target_status as enum
    ('pending','publishing','published','failed','skipped','canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_job_status as enum
    ('queued','running','succeeded','failed','dead_letter','canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_approval_status as enum
    ('not_required','pending','approved','rejected','changes_requested');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_inbox_status as enum
    ('open','resolved','ignored','snoozed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_asset_kind as enum
    ('image','video','audio','document','thumbnail');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_role as enum
    ('owner','admin','marketing_manager','social_manager','content_creator','approver','analyst','read_only');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- Provider catalog (global reference, readable by all authenticated users)
-- ----------------------------------------------------------------------------
create table if not exists public.social_providers (
  platform          public.social_platform primary key,
  label             text not null,
  -- honest capability matrix mirrored from lib/social/capabilities.ts
  capabilities      jsonb not null default '{}'::jsonb,
  auth_method       text not null default 'oauth2',
  is_enabled        boolean not null default true,
  needs_app_review  boolean not null default false,
  char_limit        integer not null default 0,
  docs_url          text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Connected accounts + (service-role-only) encrypted tokens
-- ----------------------------------------------------------------------------
create table if not exists public.social_accounts (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  platform             public.social_platform not null references public.social_providers(platform),
  account_type         text,
  provider_account_id  text,
  handle               text,
  display_name         text,
  avatar_url           text,
  profile_url          text,
  status               public.social_account_status not null default 'pending',
  health               text not null default 'unknown',
  scopes               text[] not null default '{}',
  last_synced_at       timestamptz,
  last_error           text,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  deleted_at           timestamptz,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (family_id, platform, provider_account_id)
);
create index if not exists idx_social_accounts_family on public.social_accounts(family_id);
create index if not exists idx_social_accounts_platform on public.social_accounts(family_id, platform);

create table if not exists public.social_account_tokens (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references public.social_accounts(id) on delete cascade,
  family_id            uuid references public.families(id) on delete cascade,
  platform             public.social_platform not null,
  provider_account_id  text,
  access_token_enc     text,
  refresh_token_enc    text,
  token_type           text,
  scope                text,
  expires_at           timestamptz,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_tokens_account on public.social_account_tokens(account_id);

-- ----------------------------------------------------------------------------
-- Unified feed
-- ----------------------------------------------------------------------------
create table if not exists public.social_feed_items (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid not null references public.social_accounts(id) on delete cascade,
  platform             public.social_platform not null,
  provider_object_id   text,
  author_name          text,
  author_handle        text,
  author_avatar_url    text,
  permalink_url        text,
  body                 text,
  media_type           text,
  media                jsonb not null default '[]'::jsonb,
  metrics              jsonb not null default '{}'::jsonb,
  posted_at            timestamptz,
  fetched_at           timestamptz not null default now(),
  status               text not null default 'active',
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  deleted_at           timestamptz,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (account_id, provider_object_id)
);
create index if not exists idx_social_feed_family_time on public.social_feed_items(family_id, posted_at desc);
create index if not exists idx_social_feed_platform on public.social_feed_items(family_id, platform);

-- ----------------------------------------------------------------------------
-- Campaigns + drafts + per-platform variants + publish targets
-- ----------------------------------------------------------------------------
create table if not exists public.social_campaigns (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  name         text not null,
  description  text,
  status       text not null default 'active',
  goal         text,
  color        text,
  starts_on    date,
  ends_on      date,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_campaigns_family on public.social_campaigns(family_id);

create table if not exists public.social_posts (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null,
  campaign_id       uuid references public.social_campaigns(id) on delete set null,
  title             text,
  body              text not null default '',
  kind              public.social_post_kind not null default 'text',
  status            public.social_post_status not null default 'draft',
  link              text,
  scheduled_for     timestamptz,
  published_at      timestamptz,
  approval_status   public.social_approval_status not null default 'not_required',
  approved_by       uuid references auth.users(id) on delete set null,
  approved_at       timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  deleted_at        timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_social_posts_family on public.social_posts(family_id, status);
create index if not exists idx_social_posts_schedule on public.social_posts(family_id, scheduled_for);

create table if not exists public.social_post_variants (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.social_posts(id) on delete cascade,
  family_id    uuid not null references public.families(id) on delete cascade,
  platform     public.social_platform not null,
  body         text not null default '',
  hashtags     text[] not null default '{}',
  mentions     text[] not null default '{}',
  char_count   integer not null default 0,
  status       text not null default 'ready',
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (post_id, platform)
);
create index if not exists idx_social_variants_post on public.social_post_variants(post_id);

create table if not exists public.social_post_targets (
  id                   uuid primary key default gen_random_uuid(),
  post_id              uuid not null references public.social_posts(id) on delete cascade,
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete set null,
  platform             public.social_platform not null,
  status               public.social_target_status not null default 'pending',
  provider_object_id   text,
  permalink_url        text,
  error                text,
  scheduled_for        timestamptz,
  published_at         timestamptz,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_targets_post on public.social_post_targets(post_id);
create index if not exists idx_social_targets_family on public.social_post_targets(family_id, status);

-- ----------------------------------------------------------------------------
-- Media library + post<->asset links
-- ----------------------------------------------------------------------------
create table if not exists public.social_media_library (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  kind         public.social_asset_kind not null,
  title        text,
  url          text,
  storage_path text,
  mime_type    text,
  width        integer,
  height       integer,
  duration_ms  integer,
  size_bytes   bigint,
  alt_text     text,
  tags         text[] not null default '{}',
  source       text not null default 'upload',   -- upload | ai_generated | prompt | storyboard
  status       text not null default 'ready',     -- ready | processing | prompt_only | failed
  usage_count  integer not null default 0,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_media_family on public.social_media_library(family_id, kind);

create table if not exists public.social_post_assets (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.social_posts(id) on delete cascade,
  family_id    uuid not null references public.families(id) on delete cascade,
  asset_id     uuid not null references public.social_media_library(id) on delete cascade,
  platform     public.social_platform,
  position     integer not null default 0,
  role         text not null default 'primary',
  created_by   uuid references auth.users(id) on delete set null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_post_assets_post on public.social_post_assets(post_id);

-- ----------------------------------------------------------------------------
-- Scheduling + publish pipeline
-- ----------------------------------------------------------------------------
create table if not exists public.social_schedules (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.social_posts(id) on delete cascade,
  family_id     uuid not null references public.families(id) on delete cascade,
  scheduled_for timestamptz not null,
  timezone      text not null default 'UTC',
  recurrence    text not null default 'none',
  status        text not null default 'scheduled',
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_social_schedules_due on public.social_schedules(family_id, scheduled_for);

create table if not exists public.social_publish_jobs (
  id               uuid primary key default gen_random_uuid(),
  post_id          uuid not null references public.social_posts(id) on delete cascade,
  family_id        uuid not null references public.families(id) on delete cascade,
  status           public.social_job_status not null default 'queued',
  scheduled_for    timestamptz not null default now(),
  attempts         integer not null default 0,
  max_attempts     integer not null default 3,
  next_attempt_at  timestamptz,
  idempotency_key  text,
  last_error       text,
  created_by       uuid references auth.users(id) on delete set null,
  updated_by       uuid references auth.users(id) on delete set null,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_social_jobs_due on public.social_publish_jobs(status, scheduled_for);
create index if not exists idx_social_jobs_post on public.social_publish_jobs(post_id);

create table if not exists public.social_publish_results (
  id                   uuid primary key default gen_random_uuid(),
  job_id               uuid references public.social_publish_jobs(id) on delete cascade,
  target_id            uuid references public.social_post_targets(id) on delete cascade,
  post_id              uuid not null references public.social_posts(id) on delete cascade,
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete set null,
  platform             public.social_platform not null,
  status               public.social_target_status not null default 'pending',
  provider_object_id   text,
  permalink_url        text,
  error_code           text,
  error_message        text,
  raw_response         jsonb not null default '{}'::jsonb,
  attempted_at         timestamptz not null default now(),
  created_by           uuid references auth.users(id) on delete set null,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_results_post on public.social_publish_results(post_id);
create index if not exists idx_social_results_family on public.social_publish_results(family_id, status);

-- ----------------------------------------------------------------------------
-- Inbox: comments + messages
-- ----------------------------------------------------------------------------
create table if not exists public.social_comments (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete cascade,
  platform             public.social_platform not null,
  provider_object_id   text,
  feed_item_id         uuid references public.social_feed_items(id) on delete set null,
  parent_provider_id   text,
  kind                 text not null default 'comment',   -- comment | mention | reply
  author_name          text,
  author_handle        text,
  body                 text,
  permalink_url        text,
  status               public.social_inbox_status not null default 'open',
  assigned_to          uuid references auth.users(id) on delete set null,
  posted_at            timestamptz,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  deleted_at           timestamptz,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_comments_inbox on public.social_comments(family_id, status);

create table if not exists public.social_messages (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete cascade,
  platform             public.social_platform not null,
  provider_object_id   text,
  thread_id            text,
  direction            text not null default 'inbound',   -- inbound | outbound
  author_name          text,
  author_handle        text,
  body                 text,
  status               public.social_inbox_status not null default 'open',
  assigned_to          uuid references auth.users(id) on delete set null,
  posted_at            timestamptz,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  deleted_at           timestamptz,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_messages_inbox on public.social_messages(family_id, status);

-- ----------------------------------------------------------------------------
-- Analytics + AI generations + templates + calendar
-- ----------------------------------------------------------------------------
create table if not exists public.social_analytics_snapshots (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete cascade,
  post_id              uuid references public.social_posts(id) on delete cascade,
  platform             public.social_platform not null,
  captured_for         date not null default current_date,
  impressions          bigint not null default 0,
  reach                bigint not null default 0,
  likes                bigint not null default 0,
  comments             bigint not null default 0,
  shares               bigint not null default 0,
  saves                bigint not null default 0,
  clicks               bigint not null default 0,
  views                bigint not null default 0,
  watch_time_seconds   bigint not null default 0,
  followers            bigint not null default 0,
  engagement_rate      numeric(6,4) not null default 0,
  metrics              jsonb not null default '{}'::jsonb,
  created_by           uuid references auth.users(id) on delete set null,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_analytics_family on public.social_analytics_snapshots(family_id, platform, captured_for);

create table if not exists public.social_ai_generations (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  post_id      uuid references public.social_posts(id) on delete set null,
  kind         text not null,                       -- caption | hashtags | rewrite | ideas | video_script | ...
  platform     public.social_platform,
  prompt       text,
  input        jsonb not null default '{}'::jsonb,
  output       jsonb not null default '{}'::jsonb,
  model        text,
  tokens       integer not null default 0,
  status       text not null default 'succeeded',
  created_by   uuid references auth.users(id) on delete set null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_ai_family on public.social_ai_generations(family_id, created_at desc);

create table if not exists public.social_content_templates (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  name         text not null,
  kind         public.social_post_kind not null default 'text',
  body         text not null default '',
  platforms    text[] not null default '{}',
  hashtags     text[] not null default '{}',
  status       text not null default 'active',
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_templates_family on public.social_content_templates(family_id);

create table if not exists public.social_calendar_items (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  post_id       uuid references public.social_posts(id) on delete cascade,
  campaign_id   uuid references public.social_campaigns(id) on delete set null,
  title         text,
  platform      public.social_platform,
  scheduled_for timestamptz not null,
  status        text not null default 'scheduled',
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_social_calendar_due on public.social_calendar_items(family_id, scheduled_for);

-- ----------------------------------------------------------------------------
-- Webhooks, provider errors, usage, audit, settings, access
-- ----------------------------------------------------------------------------
create table if not exists public.social_webhook_events (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete set null,
  platform             public.social_platform not null,
  provider_object_id   text,
  event_type           text,
  payload              jsonb not null default '{}'::jsonb,
  signature_ok         boolean not null default false,
  processed            boolean not null default false,
  processed_at         timestamptz,
  received_at          timestamptz not null default now(),
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_webhooks_unprocessed on public.social_webhook_events(processed, received_at);

create table if not exists public.social_provider_errors (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid references public.families(id) on delete cascade,
  account_id    uuid references public.social_accounts(id) on delete set null,
  platform      public.social_platform not null,
  scope         text,
  error_code    text,
  error_message text,
  context       jsonb not null default '{}'::jsonb,
  occurred_at   timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_social_provider_errors on public.social_provider_errors(platform, occurred_at desc);

create table if not exists public.social_usage_events (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  platform     public.social_platform,
  kind         text not null,                       -- ai_generation | publish | media_upload | feed_sync
  quantity     integer not null default 1,
  unit         text not null default 'count',
  occurred_at  timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_usage_family on public.social_usage_events(family_id, occurred_at desc);

create table if not exists public.social_audit_logs (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  actor_id     uuid references auth.users(id) on delete set null,
  action       text not null,
  entity_type  text,
  entity_id    uuid,
  summary      text,
  before       jsonb,
  after        jsonb,
  ip           text,
  occurred_at  timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_audit_family on public.social_audit_logs(family_id, occurred_at desc);

create table if not exists public.social_settings (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade unique,
  default_timezone   text not null default 'UTC',
  default_platforms  text[] not null default '{}',
  require_approval   boolean not null default false,
  auto_hashtags      boolean not null default true,
  signature          text,
  ai_tone            text not null default 'friendly',
  created_by         uuid references auth.users(id) on delete set null,
  updated_by         uuid references auth.users(id) on delete set null,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.social_access_permissions (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  member_id    uuid references public.family_members(id) on delete set null,
  social_role  public.social_role not null default 'read_only',
  status       text not null default 'active',
  granted_by   uuid references auth.users(id) on delete set null,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (family_id, user_id)
);
create index if not exists idx_social_access_family on public.social_access_permissions(family_id);

-- ----------------------------------------------------------------------------
-- Permission helper (SECURITY DEFINER): granular in-family social role check.
-- Resolves the caller's social role (explicit row, else default by member role)
-- and tests it against the role->permission matrix mirrored from lib/social/roles.ts.
-- ----------------------------------------------------------------------------
create or replace function public.social_role_for(p_family_id uuid)
returns public.social_role language sql security definer stable set search_path = public as $$
  select coalesce(
    (select social_role from public.social_access_permissions
       where family_id = p_family_id and user_id = auth.uid() and status = 'active' limit 1),
    (select case fm.role
              when 'parent' then 'admin'::public.social_role
              when 'adult'  then 'marketing_manager'::public.social_role
              when 'teen'   then 'content_creator'::public.social_role
              else 'read_only'::public.social_role
            end
       from public.family_members fm
      where fm.family_id = p_family_id and fm.user_id = auth.uid() and fm.is_active
      limit 1)
  );
$$;

create or replace function public.social_has_permission(p_family_id uuid, p_permission text)
returns boolean language sql security definer stable set search_path = public as $$
  with role_cte as (select public.social_role_for(p_family_id) as r)
  select public.is_family_member(p_family_id) and (
    select case (select r from role_cte)
      when 'owner' then true
      when 'admin' then true
      when 'marketing_manager' then p_permission in
        ('connect_accounts','view_feed','create_drafts','generate_ai','upload_media',
         'publish_posts','schedule_posts','approve_posts','view_analytics','manage_settings')
      when 'social_manager' then p_permission in
        ('view_feed','create_drafts','generate_ai','upload_media','publish_posts','schedule_posts','view_analytics')
      when 'content_creator' then p_permission in
        ('view_feed','create_drafts','generate_ai','upload_media')
      when 'approver' then p_permission in ('view_feed','approve_posts','view_analytics')
      when 'analyst' then p_permission in ('view_feed','view_analytics')
      when 'read_only' then p_permission in ('view_feed')
      else false
    end
  );
$$;

-- ----------------------------------------------------------------------------
-- Audit trigger: record account + post + result mutations into social_audit_logs.
-- ----------------------------------------------------------------------------
create or replace function public.social_write_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_family uuid;
  v_id uuid;
begin
  if (tg_op = 'DELETE') then
    v_family := old.family_id; v_id := old.id;
  else
    v_family := new.family_id; v_id := new.id;
  end if;
  if v_family is not null then
    insert into public.social_audit_logs (family_id, actor_id, action, entity_type, entity_id, summary)
    values (v_family, auth.uid(), tg_op, tg_table_name, v_id,
            tg_op || ' on ' || tg_table_name);
  end if;
  if (tg_op = 'DELETE') then return old; end if;
  return new;
end; $$;

drop trigger if exists trg_audit_social_accounts on public.social_accounts;
create trigger trg_audit_social_accounts
  after insert or update or delete on public.social_accounts
  for each row execute function public.social_write_audit();

drop trigger if exists trg_audit_social_posts on public.social_posts;
create trigger trg_audit_social_posts
  after insert or update or delete on public.social_posts
  for each row execute function public.social_write_audit();

drop trigger if exists trg_audit_social_results on public.social_publish_results;
create trigger trg_audit_social_results
  after insert or update on public.social_publish_results
  for each row execute function public.social_write_audit();

-- ----------------------------------------------------------------------------
-- updated_at triggers for every social_* table that has the column.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'updated_at'
      and table_name like 'social\_%'
    group by table_name
  loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
do $$
declare t text;
declare social_tables text[] := array[
  'social_accounts','social_feed_items','social_campaigns','social_posts',
  'social_post_variants','social_post_targets','social_media_library',
  'social_post_assets','social_schedules','social_publish_jobs','social_publish_results',
  'social_comments','social_messages','social_analytics_snapshots','social_ai_generations',
  'social_content_templates','social_calendar_items','social_provider_errors',
  'social_usage_events','social_audit_logs','social_settings','social_access_permissions'
];
begin
  -- enable RLS on every social_* table (incl. tokens, providers, webhooks)
  for t in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name like 'social\_%'
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;

  -- generic family-scoped CRUD for the household tables above
  foreach t in array social_tables loop
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t);
  end loop;
end $$;

-- Providers: global read-only reference for any authenticated user.
drop policy if exists social_providers_read on public.social_providers;
create policy social_providers_read on public.social_providers for select
  using (auth.role() = 'authenticated');

-- Tokens: NO policy → only the service-role client (which bypasses RLS) can touch
-- them. RLS is enabled above, so authenticated users get zero rows. This is the
-- deliberate "secure token storage" boundary; never add a permissive policy here.

-- Webhook events: family members may read events scoped to their family; writes
-- are service-role only (no insert/update policy).
drop policy if exists social_webhooks_select on public.social_webhook_events;
create policy social_webhooks_select on public.social_webhook_events for select
  using (family_id is not null and public.is_family_member(family_id));

-- Tighten the publish-sensitive writes to the granular role (defense in depth on
-- top of family isolation). Publishing/scheduling requires the matching permission.
drop policy if exists social_publish_jobs_insert on public.social_publish_jobs;
create policy social_publish_jobs_insert on public.social_publish_jobs for insert
  with check (public.social_has_permission(family_id, 'publish_posts')
              or public.social_has_permission(family_id, 'schedule_posts'));

-- These two policy names were already created generically by the loop above;
-- drop them first, then recreate with the stricter manage_access check.
drop policy if exists social_access_permissions_insert on public.social_access_permissions;
create policy social_access_permissions_insert on public.social_access_permissions for insert
  with check (public.is_family_admin(family_id) or public.social_has_permission(family_id, 'manage_access'));
drop policy if exists social_access_permissions_update on public.social_access_permissions;
create policy social_access_permissions_update on public.social_access_permissions for update
  using (public.is_family_admin(family_id) or public.social_has_permission(family_id, 'manage_access'))
  with check (public.is_family_admin(family_id) or public.social_has_permission(family_id, 'manage_access'));

-- ----------------------------------------------------------------------------
-- Seed the provider catalog (mirrors lib/social/capabilities.ts).
-- ----------------------------------------------------------------------------
insert into public.social_providers (platform, label, auth_method, needs_app_review, char_limit, docs_url) values
  ('x',         'X (Twitter)',         'oauth2', false, 280,   'https://developer.x.com/en/docs'),
  ('facebook',  'Facebook Pages',      'oauth2', true,  63206, 'https://developers.facebook.com/docs/pages-api'),
  ('instagram', 'Instagram Business',  'oauth2', true,  2200,  'https://developers.facebook.com/docs/instagram-api'),
  ('linkedin',  'LinkedIn',            'oauth2', true,  3000,  'https://learn.microsoft.com/en-us/linkedin/marketing/'),
  ('tiktok',    'TikTok',              'oauth2', true,  2200,  'https://developers.tiktok.com/doc/content-posting-api-get-started'),
  ('youtube',   'YouTube',             'oauth2', true,  5000,  'https://developers.google.com/youtube/v3'),
  ('pinterest', 'Pinterest',           'oauth2', true,  500,   'https://developers.pinterest.com/docs/api/v5/'),
  ('threads',   'Threads',             'oauth2', true,  500,   'https://developers.facebook.com/docs/threads'),
  ('reddit',    'Reddit',              'oauth2', false, 40000, 'https://www.reddit.com/dev/api/')
on conflict (platform) do update set
  label = excluded.label,
  auth_method = excluded.auth_method,
  needs_app_review = excluded.needs_app_review,
  char_limit = excluded.char_limit,
  docs_url = excluded.docs_url,
  updated_at = now();


-- ============================================================
-- Migration 0035: Push devices
-- ============================================================
-- FamilyOS :: 0035 push devices
-- Stores per-user push registrations so the notification engine can deliver
-- pushes to the installed PWA (Web Push / VAPID) and the native iOS/iPadOS and
-- Android apps (Capacitor → APNs/FCM tokens). One row per physical device.
--
-- Security: a user may only see/manage their OWN devices (user_id = auth.uid()).
-- The server-role dispatcher (lib/server/push.ts) reads across users to send.

create table if not exists public.push_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  family_id     uuid references public.families(id) on delete set null,
  platform      text not null default 'web',     -- web | ios | android
  provider      text not null default 'webpush', -- webpush | fcm | apns
  -- Web Push (VAPID) fields:
  endpoint      text,
  p256dh        text,
  auth          text,
  -- Native (APNs/FCM) token:
  token         text,
  -- Stable per-device key (endpoint for web, token for native) for upsert.
  device_key    text not null,
  user_agent    text,
  enabled       boolean not null default true,
  last_seen_at  timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, device_key)
);
create index if not exists idx_push_devices_user on public.push_devices(user_id);
create index if not exists idx_push_devices_enabled on public.push_devices(enabled) where enabled;

-- updated_at trigger (matches the project-wide pattern).
drop trigger if exists trg_set_updated_at on public.push_devices;
create trigger trg_set_updated_at before update on public.push_devices
  for each row execute function public.set_updated_at();

-- RLS: own-device only.
alter table public.push_devices enable row level security;

drop policy if exists push_devices_select on public.push_devices;
create policy push_devices_select on public.push_devices for select
  using (user_id = auth.uid());
drop policy if exists push_devices_insert on public.push_devices;
create policy push_devices_insert on public.push_devices for insert
  with check (user_id = auth.uid());
drop policy if exists push_devices_update on public.push_devices;
create policy push_devices_update on public.push_devices for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists push_devices_delete on public.push_devices;
create policy push_devices_delete on public.push_devices for delete
  using (user_id = auth.uid());


-- ============================================================
-- Migration 0036: Home & Maintenance
-- ============================================================
-- FamilyOS :: 0036 home & maintenance command center
-- Turns "Home & Maintenance" into a full homeowner system: properties, enriched
-- assets, first-class warranty management, a maintenance + AI-forecast loop,
-- service history, and saved contractors ("find a pro"). Builds on the existing
-- home_assets + maintenance_tasks tables (0002) and warranty document storage
-- (0007); nothing here breaks those.
--
-- Every table is family-scoped via public.is_family_member(family_id) — the same
-- hard isolation boundary used across FamilyOS. updated_at is auto-maintained.

-- ----------------------------------------------------------------------------
-- Properties
-- ----------------------------------------------------------------------------
create table if not exists public.homes (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  name          text not null,                 -- "Main House", "Lake Cabin"
  address       text,
  home_type     text,                          -- single_family | condo | townhouse | apartment | other
  year_built    integer,
  square_feet   integer,
  bedrooms      integer,
  bathrooms     numeric(4,1),
  purchase_date date,
  is_primary    boolean not null default true,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  deleted_at    timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_homes_family on public.homes(family_id);

-- ----------------------------------------------------------------------------
-- Enrich existing home_assets for warranties + AI maintenance forecasting
-- ----------------------------------------------------------------------------
alter table public.home_assets add column if not exists home_id uuid references public.homes(id) on delete set null;
alter table public.home_assets add column if not exists serial_number text;
alter table public.home_assets add column if not exists installed_on date;
alter table public.home_assets add column if not exists filter_size text;        -- e.g. 16x25x1
alter table public.home_assets add column if not exists purchase_price numeric(12,2);
alter table public.home_assets add column if not exists expected_life_years integer;
alter table public.home_assets add column if not exists condition text;          -- new | good | fair | poor
alter table public.home_assets add column if not exists last_serviced_on date;
create index if not exists idx_home_assets_home on public.home_assets(home_id);

-- ----------------------------------------------------------------------------
-- Saved contractors ("find a pro")
-- ----------------------------------------------------------------------------
create table if not exists public.home_contractors (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  name          text not null,
  trade         text,                          -- hvac | plumbing | electrical | roofing | appliance | general | landscaping | pest
  company       text,
  phone         text,
  email         text,
  website       text,
  rating        integer,                        -- 1..5
  hourly_rate   numeric(10,2),
  is_preferred  boolean not null default false,
  last_used_on  date,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  deleted_at    timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_home_contractors_family on public.home_contractors(family_id);

-- ----------------------------------------------------------------------------
-- First-class warranties (manufacturer / extended / home warranty / service plan)
-- ----------------------------------------------------------------------------
create table if not exists public.home_warranties (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  home_id       uuid references public.homes(id) on delete set null,
  asset_id      uuid references public.home_assets(id) on delete set null,
  name          text not null,                 -- "LG Fridge extended warranty"
  provider      text,                          -- "LG", "Asurion", "First American"
  warranty_type text not null default 'manufacturer', -- manufacturer | extended | home_warranty | service_plan
  policy_number text,
  coverage      text,                          -- what's covered, deductibles
  starts_on     date,
  expires_on    date,
  cost          numeric(12,2),
  premium_period text,                         -- one_time | monthly | annual
  claim_phone   text,
  claim_url     text,
  claim_email   text,
  document_id   uuid references public.documents(id) on delete set null,
  status        text not null default 'active', -- active | expired | claimed | cancelled
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  deleted_at    timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_home_warranties_family on public.home_warranties(family_id);
create index if not exists idx_home_warranties_asset on public.home_warranties(asset_id);
create index if not exists idx_home_warranties_expiry on public.home_warranties(family_id, expires_on);

-- ----------------------------------------------------------------------------
-- Service history log (per asset / home)
-- ----------------------------------------------------------------------------
create table if not exists public.home_service_records (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  home_id       uuid references public.homes(id) on delete set null,
  asset_id      uuid references public.home_assets(id) on delete set null,
  contractor_id uuid references public.home_contractors(id) on delete set null,
  title         text not null,
  service_date  date not null default current_date,
  provider      text,
  cost          numeric(12,2),
  description   text,
  next_due_on   date,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  deleted_at    timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_home_service_family on public.home_service_records(family_id, service_date desc);
create index if not exists idx_home_service_asset on public.home_service_records(asset_id);

-- ----------------------------------------------------------------------------
-- AI logs (maintenance forecasting, repair diagnosis, find-a-pro guidance)
-- ----------------------------------------------------------------------------
create table if not exists public.home_ai_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  asset_id    uuid references public.home_assets(id) on delete set null,
  kind        text not null,                   -- forecast | diagnose | find_pro
  input       jsonb not null default '{}'::jsonb,
  output      jsonb not null default '{}'::jsonb,
  model       text,
  status      text not null default 'succeeded',
  created_by  uuid references auth.users(id) on delete set null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_home_ai_family on public.home_ai_logs(family_id, created_at desc);

-- ----------------------------------------------------------------------------
-- updated_at triggers for the new tables
-- ----------------------------------------------------------------------------
do $$
declare t text;
declare tbls text[] := array['homes','home_contractors','home_warranties','home_service_records','home_ai_logs'];
begin
  foreach t in array tbls loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Row Level Security — family-scoped CRUD on every new table
-- ----------------------------------------------------------------------------
do $$
declare t text;
declare tbls text[] := array['homes','home_contractors','home_warranties','home_service_records','home_ai_logs'];
begin
  foreach t in array tbls loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t);
  end loop;
end $$;


-- ============================================================
-- Migration 0037: Auto & Vehicles
-- ============================================================
-- FamilyOS :: 0037 auto / vehicles command center
-- A full vehicle system mirroring Home & Maintenance: vehicles, driver licenses,
-- registrations, inspection stickers, insurance (full policy + an emergency
-- quick-glance), rental cars, a service log, and AI logs. Every record carries a
-- renewal/expiry date so the app can surface reminders.
--
-- Family-scoped via public.is_family_member(family_id); updated_at auto-maintained.

-- ----------------------------------------------------------------------------
-- Vehicles
-- ----------------------------------------------------------------------------
create table if not exists public.vehicles (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  nickname        text,
  make            text,
  model           text,
  year            integer,
  trim            text,
  color           text,
  vin             text,
  license_plate   text,
  plate_state     text,
  body_type       text,           -- sedan | suv | truck | van | coupe | ev | motorcycle | other
  fuel_type       text,           -- gas | diesel | hybrid | electric
  mileage         integer,
  purchase_date   date,
  primary_driver  uuid references public.family_members(id) on delete set null,
  status          text not null default 'active',  -- active | sold | stored
  photo_url       text,
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null,
  deleted_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_vehicles_family on public.vehicles(family_id);

-- ----------------------------------------------------------------------------
-- Driver licenses (per person)
-- ----------------------------------------------------------------------------
create table if not exists public.driver_licenses (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  member_id       uuid references public.family_members(id) on delete set null,
  holder_name     text not null,
  license_number  text,
  state           text,
  license_class   text,           -- C / CDL-A / etc.
  endorsements    text,
  restrictions    text,
  issued_on       date,
  expires_on      date,
  status          text not null default 'active',
  document_id     uuid references public.documents(id) on delete set null,
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null,
  deleted_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_driver_licenses_family on public.driver_licenses(family_id, expires_on);

-- ----------------------------------------------------------------------------
-- Registrations + inspection stickers (per vehicle)
-- ----------------------------------------------------------------------------
create table if not exists public.vehicle_registrations (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  vehicle_id      uuid references public.vehicles(id) on delete cascade,
  plate           text,
  state           text,
  registered_on   date,
  expires_on      date,
  fee             numeric(10,2),
  document_id     uuid references public.documents(id) on delete set null,
  status          text not null default 'active',
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null,
  deleted_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_vehicle_registrations_family on public.vehicle_registrations(family_id, expires_on);
create index if not exists idx_vehicle_registrations_vehicle on public.vehicle_registrations(vehicle_id);

create table if not exists public.vehicle_inspections (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  vehicle_id      uuid references public.vehicles(id) on delete cascade,
  inspection_type text not null default 'safety',  -- safety | emissions | both
  station         text,
  inspected_on    date,
  expires_on      date,           -- the sticker expiry
  result          text,           -- pass | fail | advisory
  document_id     uuid references public.documents(id) on delete set null,
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null,
  deleted_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_vehicle_inspections_family on public.vehicle_inspections(family_id, expires_on);
create index if not exists idx_vehicle_inspections_vehicle on public.vehicle_inspections(vehicle_id);

-- ----------------------------------------------------------------------------
-- Insurance policies (full details + emergency quick-glance fields)
-- ----------------------------------------------------------------------------
create table if not exists public.auto_insurance_policies (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families(id) on delete cascade,
  vehicle_id        uuid references public.vehicles(id) on delete set null,
  provider          text,
  policy_number     text,
  naic              text,
  coverage_summary  text,
  liability_limits  text,           -- e.g. 100/300/100
  deductible_collision     numeric(10,2),
  deductible_comprehensive numeric(10,2),
  agent_name        text,
  agent_phone       text,
  claims_phone      text,
  roadside_phone    text,
  effective_on      date,
  expires_on        date,
  premium           numeric(10,2),
  premium_period    text,           -- monthly | 6_month | annual
  document_id       uuid references public.documents(id) on delete set null,
  is_active         boolean not null default true,
  status            text not null default 'active',
  notes             text,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  deleted_at        timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_auto_insurance_family on public.auto_insurance_policies(family_id, expires_on);

-- ----------------------------------------------------------------------------
-- Rental cars
-- ----------------------------------------------------------------------------
create table if not exists public.rental_cars (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families(id) on delete cascade,
  company           text,
  confirmation_number text,
  pickup_location   text,
  dropoff_location  text,
  pickup_at         timestamptz,
  return_at         timestamptz,
  vehicle_desc      text,
  daily_rate        numeric(10,2),
  total_cost        numeric(10,2),
  coverage          text,
  driver_member_id  uuid references public.family_members(id) on delete set null,
  status            text not null default 'upcoming', -- upcoming | active | returned | cancelled
  document_id       uuid references public.documents(id) on delete set null,
  notes             text,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  deleted_at        timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_rental_cars_family on public.rental_cars(family_id, pickup_at desc);

-- ----------------------------------------------------------------------------
-- Vehicle service log
-- ----------------------------------------------------------------------------
create table if not exists public.auto_service_records (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families(id) on delete cascade,
  vehicle_id        uuid references public.vehicles(id) on delete cascade,
  title             text not null,
  service_date      date not null default current_date,
  provider          text,
  cost              numeric(10,2),
  mileage           integer,
  description       text,
  next_due_on       date,
  next_due_mileage  integer,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  deleted_at        timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_auto_service_family on public.auto_service_records(family_id, service_date desc);
create index if not exists idx_auto_service_vehicle on public.auto_service_records(vehicle_id);

-- ----------------------------------------------------------------------------
-- AI logs (accident assistant, maintenance forecast, claim helper)
-- ----------------------------------------------------------------------------
create table if not exists public.auto_ai_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  vehicle_id  uuid references public.vehicles(id) on delete set null,
  kind        text not null,                   -- accident | maintenance | claim
  input       jsonb not null default '{}'::jsonb,
  output      jsonb not null default '{}'::jsonb,
  model       text,
  status      text not null default 'succeeded',
  created_by  uuid references auth.users(id) on delete set null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_auto_ai_family on public.auto_ai_logs(family_id, created_at desc);

-- ----------------------------------------------------------------------------
-- updated_at triggers + RLS for all new tables
-- ----------------------------------------------------------------------------
do $$
declare t text;
declare tbls text[] := array[
  'vehicles','driver_licenses','vehicle_registrations','vehicle_inspections',
  'auto_insurance_policies','rental_cars','auto_service_records','auto_ai_logs'
];
begin
  foreach t in array tbls loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);

    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t);
  end loop;
end $$;


