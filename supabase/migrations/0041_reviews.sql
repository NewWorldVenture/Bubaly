-- ============================================================
-- Migration 0041: Reviews & Reputation — Marketing Pillar 2
-- Collect star reviews from customers, moderate them, reply, feature the best,
-- and route happy customers to public review platforms (Google / App Store /
-- Trustpilot). Pairs with Pillar 1 (Surveys): an NPS promoter can be linked to
-- the review they leave.
--
-- reviews              — one row per submitted review (rating + text + moderation).
-- reputation_settings  — singleton business config (platform links + messaging).
--
-- Business-wide like the rest of marketing: RLS ENABLED with NO policies, so both
-- tables are reachable only via the service-role client — the super-admin console
-- (moderation/analytics), the public submission endpoint, and the public reviews
-- wall (server component reads approved rows via service role). No direct client
-- access.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rating             integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title              text,
  body               text,
  author_name        text,
  author_email       text,
  source             text NOT NULL DEFAULT 'internal'
                       CHECK (source IN ('internal','google','app_store','trustpilot','nps','import')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','featured','rejected')),
  reply              text,
  replied_at         timestamptz,
  replied_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  family_id          uuid REFERENCES public.families(id) ON DELETE SET NULL,
  survey_response_id uuid REFERENCES public.survey_responses(id) ON DELETE SET NULL,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON public.reviews (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON public.reviews (rating);

DROP TRIGGER IF EXISTS trg_reviews_updated_at ON public.reviews;
CREATE TRIGGER trg_reviews_updated_at
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.reputation_settings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton          boolean NOT NULL DEFAULT true UNIQUE,  -- enforce a single row
  google_url         text,
  app_store_url      text,
  play_store_url     text,
  trustpilot_url     text,
  request_headline   text,
  request_message    text,
  thank_you_high     text,
  thank_you_low      text,
  min_public_rating  integer NOT NULL DEFAULT 4 CHECK (min_public_rating BETWEEN 1 AND 5),
  auto_approve_min   integer CHECK (auto_approve_min BETWEEN 1 AND 5),
  updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_reputation_settings_updated_at ON public.reputation_settings;
CREATE TRIGGER trg_reputation_settings_updated_at
  BEFORE UPDATE ON public.reputation_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS on, no policies → service-role only.
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reputation_settings ENABLE ROW LEVEL SECURITY;
