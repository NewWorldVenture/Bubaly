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
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trips', 'trip_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members can manage %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Members can manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))',
      t
    );
  END LOOP;
END $$;


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
