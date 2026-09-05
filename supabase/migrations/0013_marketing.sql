-- ============================================================
-- Migration 0013: Admin Marketing module
-- Backs /admin/marketing. Every table follows the same security model as
-- super_admins / support_tickets: RLS is ENABLED with NO policies, so no
-- client session can read or write directly. All access happens through the
-- service-role client in the super-admin-gated admin console (which bypasses
-- RLS). This keeps marketing data fully admin-only.
--
-- "Customers" in Bubaly are existing families/subscriptions/contacts — those
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
