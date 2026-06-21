-- ============================================================
-- Migration 0029: Travel / Trip planner
-- Backs the Trip Planner (Top-50 complaint #18 "vacation planning
-- difficult → AI family trip planner"). A trip plus a checklist of items
-- (packing, to-dos, reservations, documents) the family works through.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE trip_status AS ENUM ('planning', 'booked', 'active', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trip_item_kind AS ENUM ('packing', 'todo', 'reservation', 'document');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.trips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name         text NOT NULL,
  destination  text,
  start_date   date,
  end_date     date,
  status       trip_status NOT NULL DEFAULT 'planning',
  traveler_ids uuid[] NOT NULL DEFAULT '{}',
  notes        text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trips_family ON public.trips(family_id);
CREATE INDEX IF NOT EXISTS idx_trips_dates ON public.trips(family_id, start_date);

CREATE TABLE IF NOT EXISTS public.trip_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  trip_id     uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  kind        trip_item_kind NOT NULL DEFAULT 'packing',
  label       text NOT NULL,
  details     text,
  assignee_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  is_done     boolean NOT NULL DEFAULT false,
  due_at      timestamptz,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_items_family ON public.trip_items(family_id);
CREATE INDEX IF NOT EXISTS idx_trip_items_trip ON public.trip_items(trip_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.trips;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_set_updated_at ON public.trip_items;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.trip_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
-- Explicit per-table statements (no DO/format loop): the dollar-quoted
-- format() placeholders confuse some SQL clients' statement parsers.
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage trips" ON public.trips;
CREATE POLICY "Members can manage trips" ON public.trips
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.trip_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage trip_items" ON public.trip_items;
CREATE POLICY "Members can manage trip_items" ON public.trip_items
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
