-- ============================================================
-- Migration 0064: Exit-Intent Popups — marketing_exit_intent
-- Audience-targeted offers shown on the public site when a visitor is about to
-- leave (mouseleave) or scrolls past a threshold. Reuses the personalization
-- audience-match shape. Counters are bumped from a public endpoint via a
-- SECURITY DEFINER RPC (the table has no client policies). Business-wide: RLS
-- ENABLED, NO policies → service-role only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_exit_intent (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  headline       text NOT NULL,
  body           text,
  cta_label      text,
  cta_href       text,
  match          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- audience constraints (all must hold)
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {mode:'mouseleave'|'scroll', delayMs, scrollPercent}
  priority       integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  impressions    integer NOT NULL DEFAULT 0,
  conversions    integer NOT NULL DEFAULT 0,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_exit_intent_active
  ON public.marketing_exit_intent (status, priority DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.marketing_exit_intent;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.marketing_exit_intent
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketing_exit_intent ENABLE ROW LEVEL SECURITY;
-- NO policies → service-role only (matches the marketing-table convention).

-- Public counter bump. SECURITY DEFINER so the impression/conversion beacon can
-- increment without table policies; only active, non-deleted offers are counted.
CREATE OR REPLACE FUNCTION public.bump_exit_intent(p_id uuid, p_metric text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_metric = 'conversion' THEN
    UPDATE public.marketing_exit_intent
       SET conversions = conversions + 1
     WHERE id = p_id AND status = 'active' AND deleted_at IS NULL;
  ELSE
    UPDATE public.marketing_exit_intent
       SET impressions = impressions + 1
     WHERE id = p_id AND status = 'active' AND deleted_at IS NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_exit_intent(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_exit_intent(uuid, text) TO service_role;
