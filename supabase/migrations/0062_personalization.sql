-- ============================================================
-- Migration 0062: Personalization Engine — marketing_personalization_rules
-- Per-slot content variants resolved against a visitor/segment context (UTM
-- source/medium/campaign, returning, segments, session count, path, country).
-- The server picks the highest-priority matching rule for a slot (e.g.
-- home_hero, pricing_cta) and renders its variant; exposures can be recorded via
-- the A/B /api/ab/track plumbing. Business-wide: RLS ENABLED, NO policies →
-- service-role only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_personalization_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slot        text NOT NULL,                       -- e.g. home_hero, pricing_cta
  match       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- audience constraints (all must hold)
  variant     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- content: headline/subhead/body/cta_*
  priority    integer NOT NULL DEFAULT 0,          -- higher wins
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_personalization_slot
  ON public.marketing_personalization_rules (slot, status, priority DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.marketing_personalization_rules;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.marketing_personalization_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketing_personalization_rules ENABLE ROW LEVEL SECURITY;
-- NO policies → service-role only (matches the marketing-table convention).
