-- ============================================================
-- Migration 0244: Declutter Missions — "House is cluttered" (TODO-0411)
--   declutter_zones     — the places that get messy (a counter, a drawer, the
--                         garage floor…) with a 1–5 clutter score and last reset.
--   declutter_missions  — 5–30 minute missions per zone: who, when, done/skipped,
--                         items removed, before/after photos, points.
--   declutter_sessions  — timed sessions (streaks, minutes, items removed).
-- Family-owned data: members read/write their own family's rows (RLS).
-- Additive + idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.declutter_zones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name            text NOT NULL,
  room            text,
  kind            text NOT NULL DEFAULT 'surface'
                  CHECK (kind IN ('surface','closet','drawer','floor','shelf','fridge','garage','entryway','desk','toys','digital','other')),
  clutter_score   integer NOT NULL DEFAULT 3 CHECK (clutter_score BETWEEN 1 AND 5),
  last_reset_at   timestamptz,
  photo_path      text,
  target_state    text,
  is_active       boolean NOT NULL DEFAULT true,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_declutter_zones_family ON public.declutter_zones (family_id, is_active, clutter_score DESC);

CREATE TABLE IF NOT EXISTS public.declutter_missions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id          uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  zone_id            uuid REFERENCES public.declutter_zones(id) ON DELETE SET NULL,
  title              text NOT NULL,
  minutes            integer NOT NULL DEFAULT 15 CHECK (minutes BETWEEN 5 AND 60),
  assignee_id        uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','skipped')),
  scheduled_for      date,
  completed_at       timestamptz,
  items_removed      integer NOT NULL DEFAULT 0 CHECK (items_removed >= 0),
  before_photo_path  text,
  after_photo_path   text,
  points             integer NOT NULL DEFAULT 5 CHECK (points BETWEEN 0 AND 100),
  notes              text,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_declutter_missions_family_status ON public.declutter_missions (family_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_declutter_missions_zone ON public.declutter_missions (zone_id);

CREATE TABLE IF NOT EXISTS public.declutter_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  zone_id         uuid REFERENCES public.declutter_zones(id) ON DELETE SET NULL,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  minutes         integer NOT NULL DEFAULT 15 CHECK (minutes BETWEEN 1 AND 480),
  missions_done   integer NOT NULL DEFAULT 0 CHECK (missions_done >= 0),
  items_removed   integer NOT NULL DEFAULT 0 CHECK (items_removed >= 0),
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_declutter_sessions_family_started ON public.declutter_sessions (family_id, started_at DESC);

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['declutter_zones','declutter_missions','declutter_sessions'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    EXECUTE format('ALTER TABLE public.%1$I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_all ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_all ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
  END LOOP;
END $$;

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['declutter_zones','declutter_missions','declutter_sessions'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN RETURN; END IF;
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
