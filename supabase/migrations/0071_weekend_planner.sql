-- ============================================================================
-- Migration 0071: Weekend Planner — discover real local events near a ZIP code
-- ----------------------------------------------------------------------------
-- Families enter a ZIP code + a mileage radius and pull everything happening in
-- the next several days from external event providers (e.g. Ticketmaster
-- Discovery). Discovered events are cached per family, and families can shortlist
-- them into plans (interested / going / maybe / passed) with assignees + notes.
-- Family-scoped RLS, updated_at triggers, indexes.
-- ============================================================================

DO $$ BEGIN CREATE TYPE weekend_plan_status AS ENUM ('interested','going','maybe','passed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- cached discovered events ----------
CREATE TABLE IF NOT EXISTS public.weekend_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  source          text NOT NULL DEFAULT 'ticketmaster',
  external_id     text,
  title           text NOT NULL,
  category        text,
  description     text,
  venue_name      text,
  address         text,
  city            text,
  region          text,
  postal_code     text,
  latitude        double precision,
  longitude       double precision,
  starts_at       timestamptz,
  ends_at         timestamptz,
  url             text,
  image_url       text,
  price_min_cents integer CHECK (price_min_cents IS NULL OR price_min_cents >= 0),
  price_max_cents integer CHECK (price_max_cents IS NULL OR price_max_cents >= 0),
  currency        text NOT NULL DEFAULT 'USD',
  distance_miles  numeric(6,1) CHECK (distance_miles IS NULL OR distance_miles >= 0),
  is_family_friendly boolean NOT NULL DEFAULT false,
  search_zip      text,
  search_radius   integer,
  raw             jsonb NOT NULL DEFAULT '{}',
  discovered_at   timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_weekend_events_family ON public.weekend_events (family_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_weekend_events_category ON public.weekend_events (family_id, category);

-- ---------- shortlisted plans ----------
CREATE TABLE IF NOT EXISTS public.weekend_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES public.weekend_events(id) ON DELETE CASCADE,
  status          weekend_plan_status NOT NULL DEFAULT 'interested',
  member_ids      uuid[] NOT NULL DEFAULT '{}',
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_weekend_plans_family ON public.weekend_plans (family_id, status);

-- ---------- search history (drives default ZIP + radius) ----------
CREATE TABLE IF NOT EXISTS public.weekend_searches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  zip             text NOT NULL,
  radius_miles    integer NOT NULL DEFAULT 25,
  days            integer NOT NULL DEFAULT 6 CHECK (days BETWEEN 1 AND 30),
  result_count    integer NOT NULL DEFAULT 0,
  last_run_at     timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_weekend_searches_family ON public.weekend_searches (family_id, last_run_at DESC);

-- ============================================================================
-- RLS + updated_at triggers
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['weekend_events','weekend_plans','weekend_searches'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ============================================================================
-- Done! Weekend Planner — local event discovery + family shortlisting.
-- ============================================================================
