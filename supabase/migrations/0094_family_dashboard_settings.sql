-- ============================================================================
-- Migration 0093: Family dashboard settings (child-customization permissions)
-- ----------------------------------------------------------------------------
-- Per-family controls for the customizable dashboard: whether children may
-- personalize their own layout, and whether everyone is locked to the family
-- default. One row per family. Writes are parent/admin-only (enforced in the
-- server action); RLS provides family isolation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.family_dashboard_settings (
  family_id                  uuid PRIMARY KEY REFERENCES public.families(id) ON DELETE CASCADE,
  allow_child_customization  boolean NOT NULL DEFAULT true,
  lock_to_family_default     boolean NOT NULL DEFAULT false,
  updated_by                 uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.family_dashboard_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage family_dashboard_settings" ON public.family_dashboard_settings;
CREATE POLICY "Members manage family_dashboard_settings" ON public.family_dashboard_settings
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_family_dashboard_settings_updated_at ON public.family_dashboard_settings;
CREATE TRIGGER trg_family_dashboard_settings_updated_at BEFORE UPDATE ON public.family_dashboard_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Done!
-- ============================================================================
