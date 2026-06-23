-- ============================================================
-- Migration 0054: Feature tier settings (admin "Tier & Features")
-- Lets a super-admin set the minimum subscription tier for each platform
-- feature: free / basic / plus / off. Stored as sparse overrides keyed by the
-- feature's route; a missing key falls back to the code default in
-- lib/features/catalog.ts.
--
-- Semantics (resolved in lib/features/catalog.ts):
--   free  → visible to Free, Basic, Plus
--   basic → visible to Basic, Plus; LOCKED for Free
--   plus  → visible to Plus only; LOCKED for Basic + Free
--   off   → hidden / blocked for everyone (super-admins still preview)
--
-- Readable by any authenticated user (the app gates nav + routes with it).
-- Writable by the service role only (admin action, super-admin gated + audited).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.feature_settings (
  key        text PRIMARY KEY,
  tier       text NOT NULL CHECK (tier IN ('free','basic','plus','off')),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_feature_settings_updated_at ON public.feature_settings;
CREATE TRIGGER trg_feature_settings_updated_at BEFORE UPDATE ON public.feature_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.feature_settings ENABLE ROW LEVEL SECURITY;

-- Everyone signed in can READ the gating config (needed to render nav + gate
-- routes). Writes go through the service role only — no write policy.
DROP POLICY IF EXISTS feature_settings_read ON public.feature_settings;
CREATE POLICY feature_settings_read ON public.feature_settings
  FOR SELECT TO authenticated USING (true);
