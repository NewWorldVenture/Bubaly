-- ============================================================
-- Migration 0042: Family Location (locator, places, geofencing)
-- Bubaly's answer to FamilyWall's flagship "Family Locator". Three tables:
--   family_places     — saved places (home/school/work) with a geofence radius
--   member_locations  — each member's latest position (one row per member)
--   location_events   — arrival/departure/ping history
-- Location sharing is strictly opt-in (member_locations.is_sharing) and every
-- row is family-scoped via is_family_member RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE location_event_type AS ENUM ('arrived', 'left', 'ping');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.family_places (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  icon        text,                       -- home / school / work / gym / other
  address     text,
  latitude    double precision NOT NULL,
  longitude   double precision NOT NULL,
  radius_m    integer NOT NULL DEFAULT 150,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_places_family ON public.family_places(family_id);

CREATE TABLE IF NOT EXISTS public.member_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  latitude    double precision,
  longitude   double precision,
  accuracy_m  double precision,
  battery     integer,                     -- 0–100 if reported
  place_id    uuid REFERENCES public.family_places(id) ON DELETE SET NULL,
  is_sharing  boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id)
);
CREATE INDEX IF NOT EXISTS idx_member_locations_family ON public.member_locations(family_id);

CREATE TABLE IF NOT EXISTS public.location_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  place_id    uuid REFERENCES public.family_places(id) ON DELETE SET NULL,
  place_name  text,                        -- snapshot so history survives place edits
  event_type  location_event_type NOT NULL DEFAULT 'ping',
  latitude    double precision,
  longitude   double precision,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_location_events_member ON public.location_events(family_id, member_id, occurred_at DESC);

-- updated_at triggers
DROP TRIGGER IF EXISTS trg_set_updated_at ON public.family_places;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.family_places
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_set_updated_at ON public.member_locations;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.member_locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS (explicit per-table; no DO/format loop so the dashboard SQL editor
--    never injects ALTER statements into a dollar-quoted block) ──────────────
ALTER TABLE public.family_places ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage family_places" ON public.family_places;
CREATE POLICY "Members can manage family_places" ON public.family_places
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.member_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage member_locations" ON public.member_locations;
CREATE POLICY "Members can manage member_locations" ON public.member_locations
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.location_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage location_events" ON public.location_events;
CREATE POLICY "Members can manage location_events" ON public.location_events
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
