-- ============================================================
-- Migration 0243: Sleep Coach — "Can't sleep" (TODO-0410)
--   sleep_logs        — one row per member per night: bed/wake times, duration,
--                       quality, awakenings, source.
--   bedtime_routines  — per member: target bedtime/wake, wind-down steps, days.
--   sleep_checkins    — the 2-minute daily check-in the coach correlates with
--                       sleep: energy, mood, caffeine, screens in bed, exercise.
-- Family-owned data: members read/write their own family's rows (RLS).
-- Additive + idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sleep_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  sleep_date    date NOT NULL,                       -- the night that ended this morning
  bedtime       timestamptz NOT NULL,
  wake_time     timestamptz NOT NULL,
  duration_min  integer NOT NULL CHECK (duration_min BETWEEN 0 AND 1440),
  quality       integer CHECK (quality IS NULL OR quality BETWEEN 1 AND 5),
  awakenings    integer NOT NULL DEFAULT 0 CHECK (awakenings BETWEEN 0 AND 50),
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','wearable','estimate')),
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, sleep_date)
);
CREATE INDEX IF NOT EXISTS idx_sleep_logs_family_date ON public.sleep_logs (family_id, sleep_date DESC);

CREATE TABLE IF NOT EXISTS public.bedtime_routines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  name            text NOT NULL DEFAULT 'Bedtime routine',
  target_bedtime  time NOT NULL DEFAULT '21:00',
  target_wake     time NOT NULL DEFAULT '07:00',
  wind_down_min   integer NOT NULL DEFAULT 30 CHECK (wind_down_min BETWEEN 0 AND 240),
  steps           text[] NOT NULL DEFAULT '{}',
  days_of_week    integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  is_active       boolean NOT NULL DEFAULT true,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bedtime_routines_family_member ON public.bedtime_routines (family_id, member_id, is_active);

CREATE TABLE IF NOT EXISTS public.sleep_checkins (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id           uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  checkin_date        date NOT NULL DEFAULT CURRENT_DATE,
  energy              integer NOT NULL DEFAULT 3 CHECK (energy BETWEEN 1 AND 5),
  mood                integer NOT NULL DEFAULT 3 CHECK (mood BETWEEN 1 AND 5),
  caffeine_after_2pm  boolean NOT NULL DEFAULT false,
  screens_in_bed      boolean NOT NULL DEFAULT false,
  exercised           boolean NOT NULL DEFAULT false,
  notes               text,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS idx_sleep_checkins_family_date ON public.sleep_checkins (family_id, checkin_date DESC);

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['sleep_logs','bedtime_routines','sleep_checkins'];
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
DECLARE tbls text[] := ARRAY['sleep_logs','bedtime_routines','sleep_checkins'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN RETURN; END IF;
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
