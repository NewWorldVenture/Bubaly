-- ============================================================
-- Migration 0048: Family Dates (Smart Birthday & Anniversary Center)
-- Custom recurring celebrations beyond member birthdays — anniversaries,
-- grandparents' birthdays, "Gotcha Day", etc. Member birthdays already live on
-- family_members.birthday; the Birthday Center merges both into one countdown.
-- Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE celebration_kind AS ENUM ('birthday', 'anniversary', 'holiday', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.family_dates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title       text NOT NULL,
  kind        celebration_kind NOT NULL DEFAULT 'birthday',
  -- Full date (YYYY-MM-DD); only month/day are used for the annual recurrence,
  -- but storing the year lets us show "turning N".
  event_date  date NOT NULL,
  notes       text,
  remind_days integer NOT NULL DEFAULT 7 CHECK (remind_days >= 0),
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_dates_family ON public.family_dates(family_id);

DROP TRIGGER IF EXISTS trg_family_dates_updated_at ON public.family_dates;
CREATE TRIGGER trg_family_dates_updated_at BEFORE UPDATE ON public.family_dates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_dates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage family_dates" ON public.family_dates;
CREATE POLICY "Members can manage family_dates" ON public.family_dates
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Families can track custom celebrations alongside birthdays.
-- ============================================================
