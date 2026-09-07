-- ============================================================
-- Migration 0026: Customizable Kitchen Display layouts
-- One saved layout per family for the /display kiosk. The layout is a JSON list
-- of tiles ({ id, widget, size }), edited in-app and rendered on the display.
-- Family-scoped with the standard RLS model.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.display_layouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL UNIQUE REFERENCES public.families(id) ON DELETE CASCADE,
  tiles       jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_display_layouts_updated_at ON public.display_layouts;
CREATE TRIGGER trg_display_layouts_updated_at
  BEFORE UPDATE ON public.display_layouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.display_layouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS display_layouts_select ON public.display_layouts;
CREATE POLICY display_layouts_select ON public.display_layouts
  FOR SELECT USING (public.is_family_member(family_id));
DROP POLICY IF EXISTS display_layouts_insert ON public.display_layouts;
CREATE POLICY display_layouts_insert ON public.display_layouts
  FOR INSERT WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS display_layouts_update ON public.display_layouts;
CREATE POLICY display_layouts_update ON public.display_layouts
  FOR UPDATE USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS display_layouts_delete ON public.display_layouts;
CREATE POLICY display_layouts_delete ON public.display_layouts
  FOR DELETE USING (public.is_family_member(family_id));

-- ============================================================
-- Done! Each family can customize its kitchen-display grid.
-- ============================================================
