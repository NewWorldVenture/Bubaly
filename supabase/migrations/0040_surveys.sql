-- ============================================================
-- Migration 0040: Surveys (NPS / CSAT / CES) — Marketing Pillar 1
-- A lightweight survey engine for measuring customer sentiment:
--   * NPS  — "How likely are you to recommend…" (0–10)
--   * CSAT — "How satisfied were you…" (1–5)
--   * CES  — "How easy was it…" (1–7)
--   * custom numeric scales
--
-- surveys           — the survey definition (admin/business-owned).
-- survey_responses  — one row per submitted response (score + optional comment).
--
-- Like the rest of the marketing suite these are business-wide, not family-scoped.
-- RLS is ENABLED with NO policies, so they are reachable only through the
-- service-role client: the admin console (super-admin gated) for management and
-- analytics, and the public response endpoint (server action / server component)
-- for fetching an active survey by slug and inserting a response. There is no
-- direct client access.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.surveys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  type               text NOT NULL DEFAULT 'nps'
                       CHECK (type IN ('nps','csat','ces','custom')),
  question           text NOT NULL,
  scale_min          integer NOT NULL DEFAULT 0,
  scale_max          integer NOT NULL DEFAULT 10,
  low_label          text,
  high_label         text,
  follow_up_question text,
  thank_you_message  text,
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','active','closed')),
  audience           text,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at         timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_surveys_status ON public.surveys (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_surveys_updated_at ON public.surveys;
CREATE TRIGGER trg_surveys_updated_at
  BEFORE UPDATE ON public.surveys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.survey_responses (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id            uuid NOT NULL REFERENCES public.surveys(id) ON DELETE CASCADE,
  score                integer,
  comment              text,
  respondent_email     text,
  respondent_family_id uuid REFERENCES public.families(id) ON DELETE SET NULL,
  channel              text NOT NULL DEFAULT 'link',  -- link | email | in_app
  user_agent           text,
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON public.survey_responses (survey_id, submitted_at DESC);

DROP TRIGGER IF EXISTS trg_survey_responses_updated_at ON public.survey_responses;
CREATE TRIGGER trg_survey_responses_updated_at
  BEFORE UPDATE ON public.survey_responses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS on, no policies → service-role only (admin console + public endpoint).
ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_responses ENABLE ROW LEVEL SECURITY;
