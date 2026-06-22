-- ============================================================
-- Migration 0054: Customer Intelligence Layer
-- Visitor Tracking + Attribution + CDP-lite identity stitching.
--   mkt_visitors    — one row per anonymous visitor (the CDP profile spine);
--                     contact_id links it to a CRM contact once identified.
--   mkt_sessions    — a visit, with its acquisition source/medium/campaign.
--   mkt_touchpoints — every marketing touch, for multi-touch attribution.
-- Service-role only (RLS ENABLED, NO policies). Written by /api/mkt/track and
-- read by the admin intelligence page. Mirrors the marketing-table convention.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mkt_visitors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anonymous_id text NOT NULL UNIQUE,                 -- cookie/device id from the client
  contact_id   uuid REFERENCES public.crm_contacts(id) ON DELETE SET NULL, -- identity stitch
  device_type  text,                                 -- mobile | desktop | tablet
  country      text,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  session_count integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_visitors_contact ON public.mkt_visitors (contact_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.mkt_visitors;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.mkt_visitors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.mkt_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id  uuid REFERENCES public.mkt_visitors(id) ON DELETE CASCADE,
  source      text,                                  -- google | direct | newsletter | …
  medium      text,                                  -- organic | cpc | email | referral | …
  campaign    text,
  landing_path text,
  page_views  integer NOT NULL DEFAULT 1,
  started_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_sessions_visitor ON public.mkt_sessions (visitor_id);
CREATE INDEX IF NOT EXISTS idx_mkt_sessions_started ON public.mkt_sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS public.mkt_touchpoints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id  uuid REFERENCES public.mkt_visitors(id) ON DELETE CASCADE,
  source      text,
  medium      text,
  campaign    text,
  -- 'conversion' marks the touch where the visitor converted (signup/purchase).
  kind        text NOT NULL DEFAULT 'touch' CHECK (kind IN ('touch','conversion')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_touchpoints_visitor ON public.mkt_touchpoints (visitor_id, occurred_at);

ALTER TABLE public.mkt_visitors    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_touchpoints ENABLE ROW LEVEL SECURITY;
