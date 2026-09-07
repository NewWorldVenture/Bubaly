-- ============================================================================
-- Migration 0073: Habit Tracking — personal & family routine building
-- ----------------------------------------------------------------------------
-- A world-class habit tracker: per-member (or family-wide) habits with a
-- cadence + per-period target, daily/weekly check-ins, streak history, and an
-- AI coach that turns the check-in data into encouragement + nudges.
--
-- Two family-scoped tables:
--   habits       — the habit definitions (owner, cadence, target, schedule)
--   habit_logs   — one row per completion (habit + date + member)
-- Both use is_family_member RLS + the shared set_updated_at() trigger.
-- ============================================================================

DO $$ BEGIN CREATE TYPE habit_cadence AS ENUM ('daily','weekly'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- habit definitions ----------
CREATE TABLE IF NOT EXISTS public.habits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id        uuid REFERENCES public.family_members(id) ON DELETE SET NULL,  -- null = whole-family habit
  title            text NOT NULL,
  description      text,
  icon             text NOT NULL DEFAULT 'sparkles',     -- lucide-ish key, rendered client-side
  color            text NOT NULL DEFAULT 'violet',
  cadence          habit_cadence NOT NULL DEFAULT 'daily',
  target_per_period integer NOT NULL DEFAULT 1 CHECK (target_per_period >= 1),
  reminder_time    time,                                  -- optional local reminder
  weekdays         integer[] NOT NULL DEFAULT '{}',       -- 0..6 (Sun..Sat); empty = every day
  is_active        boolean NOT NULL DEFAULT true,
  archived_at      timestamptz,
  sort_order       integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_habits_family ON public.habits (family_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_habits_member ON public.habits (family_id, member_id);

-- ---------- check-ins ----------
CREATE TABLE IF NOT EXISTS public.habit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  habit_id      uuid NOT NULL REFERENCES public.habits(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  log_date      date NOT NULL DEFAULT current_date,
  count         integer NOT NULL DEFAULT 1 CHECK (count >= 0),
  note          text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (habit_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_habit ON public.habit_logs (family_id, habit_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_habit_logs_date ON public.habit_logs (family_id, log_date);

-- ============================================================================
-- RLS + updated_at triggers (family-scoped, same pattern as the rest of the app)
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['habits','habit_logs'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))',
      t
    );
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t
    );
  END LOOP;
END $$;

-- ============================================================================
-- Done! 2 family-scoped tables powering the Bubaly Habit Tracker.
-- ============================================================================
