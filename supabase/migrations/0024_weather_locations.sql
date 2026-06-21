-- ============================================================
-- Migration 0024: Weather saved locations
-- Per-family list of saved cities for the Weather feature. Live forecast data
-- comes from a real-time weather API in the browser; only the user's chosen
-- locations are persisted here. Family-scoped with the standard RLS model.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.weather_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  admin1      text,
  country     text,
  latitude    double precision NOT NULL,
  longitude   double precision NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Avoid duplicate saved cities within a family (rounded to ~11m).
  UNIQUE (family_id, latitude, longitude)
);

CREATE INDEX IF NOT EXISTS idx_weather_locations_family ON public.weather_locations (family_id, sort_order);

DROP TRIGGER IF EXISTS trg_weather_locations_updated_at ON public.weather_locations;
CREATE TRIGGER trg_weather_locations_updated_at
  BEFORE UPDATE ON public.weather_locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- RLS: family-scoped CRUD (matches 0004 pattern) ----------
ALTER TABLE public.weather_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS weather_locations_select ON public.weather_locations;
CREATE POLICY weather_locations_select ON public.weather_locations
  FOR SELECT USING (public.is_family_member(family_id));
DROP POLICY IF EXISTS weather_locations_insert ON public.weather_locations;
CREATE POLICY weather_locations_insert ON public.weather_locations
  FOR INSERT WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS weather_locations_update ON public.weather_locations;
CREATE POLICY weather_locations_update ON public.weather_locations
  FOR UPDATE USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS weather_locations_delete ON public.weather_locations;
CREATE POLICY weather_locations_delete ON public.weather_locations
  FOR DELETE USING (public.is_family_member(family_id));

-- ============================================================
-- Done! Families can save weather locations; forecasts are fetched live.
-- ============================================================
