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
