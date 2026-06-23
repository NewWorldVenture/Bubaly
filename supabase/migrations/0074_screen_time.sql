-- ============================================================
-- Migration 0074: Screen Time Dashboard — screen_time_entries + _limits
-- Daily per-child screen-time logging by category (educational / entertainment /
-- social / gaming / creative / other) with optional per-child daily limits.
-- Powers the "better balance" dashboard: totals vs limit, category mix, trends,
-- and under-limit streaks. Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE screen_time_category AS ENUM
    ('educational','entertainment','social','gaming','creative','communication','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.screen_time_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE CASCADE,
  entry_date  date NOT NULL DEFAULT current_date,
  minutes     integer NOT NULL DEFAULT 0 CHECK (minutes >= 0 AND minutes <= 1440),
  category    screen_time_category NOT NULL DEFAULT 'entertainment',
  device      text,
  note        text,
  logged_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_screen_time_family ON public.screen_time_entries (family_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_screen_time_member ON public.screen_time_entries (family_id, member_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS public.screen_time_limits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  daily_minutes integer NOT NULL DEFAULT 120 CHECK (daily_minutes >= 0 AND daily_minutes <= 1440),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, member_id)
);

DO $$ BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_screen_time_entries_updated_at ON public.screen_time_entries';
  EXECUTE 'CREATE TRIGGER trg_screen_time_entries_updated_at BEFORE UPDATE ON public.screen_time_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
  EXECUTE 'DROP TRIGGER IF EXISTS trg_screen_time_limits_updated_at ON public.screen_time_limits';
  EXECUTE 'CREATE TRIGGER trg_screen_time_limits_updated_at BEFORE UPDATE ON public.screen_time_limits FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
END $$;

ALTER TABLE public.screen_time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.screen_time_limits  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage screen_time_entries" ON public.screen_time_entries;
CREATE POLICY "Members manage screen_time_entries" ON public.screen_time_entries
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

DROP POLICY IF EXISTS "Members manage screen_time_limits" ON public.screen_time_limits;
CREATE POLICY "Members manage screen_time_limits" ON public.screen_time_limits
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
