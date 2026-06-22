-- ============================================================
-- Migration 0053: Landing-page metric counters
-- Atomic increment for marketing_landing_pages.views / .conversions, used by the
-- public renderer's tracking beacon (POST /api/lp/track via the service role).
-- SECURITY DEFINER so the increment is a single atomic UPDATE (no read-modify-
-- write race); only published pages are counted. Execute is restricted to the
-- service role — the public site calls it server-side, never the browser.
-- ============================================================

CREATE OR REPLACE FUNCTION public.bump_landing_metric(p_slug text, p_metric text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_metric = 'view' THEN
    UPDATE public.marketing_landing_pages
       SET views = views + 1
     WHERE slug = p_slug AND published = true AND deleted_at IS NULL;
  ELSIF p_metric = 'conversion' THEN
    UPDATE public.marketing_landing_pages
       SET conversions = conversions + 1
     WHERE slug = p_slug AND published = true AND deleted_at IS NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_landing_metric(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_landing_metric(text, text) TO service_role;
