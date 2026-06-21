-- ============================================================
-- Migration 0027: Transportation / Carpool planner
-- Backs the Rides Planner (Top-50 complaint #17 "coordinating rides
-- → AI transportation planner"). Tracks who is driving whom, when, and
-- to/from where — with an optional link to a calendar event.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE ride_status AS ENUM ('planned', 'confirmed', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.rides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title            text NOT NULL,
  ride_date        date NOT NULL,
  pickup_time      time,
  dropoff_time     time,
  pickup_location  text,
  dropoff_location text,
  -- Driver is a family member (or null when a ride still needs one).
  driver_id        uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  -- Riders are family members; kept as an array so a ride is a single row.
  rider_ids        uuid[] NOT NULL DEFAULT '{}',
  status           ride_status NOT NULL DEFAULT 'planned',
  notes            text,
  event_id         uuid REFERENCES public.calendar_events(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_family ON public.rides(family_id);
CREATE INDEX IF NOT EXISTS idx_rides_date ON public.rides(family_id, ride_date);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON public.rides(driver_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.rides;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage rides" ON public.rides;
CREATE POLICY "Members can manage rides" ON public.rides
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
