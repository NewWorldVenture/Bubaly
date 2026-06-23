-- ============================================================
-- Migration 0069: Structured Immunizations / Vaccine records
-- Replaces the free-text `medical_profiles.immunizations` blob with a real,
-- per-member vaccine ledger: what, when, which dose, next-due, lot #, provider.
-- High family value (school/camp/travel forms). Family-scoped RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.immunizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  vaccine         text NOT NULL,
  dose_label      text,                -- "Dose 1", "Booster", "Annual", …
  date_given      date,
  next_due_date   date,
  provider_name   text,
  lot_number      text,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_immunizations_family ON public.immunizations (family_id, member_id);
CREATE INDEX IF NOT EXISTS idx_immunizations_due ON public.immunizations (family_id, next_due_date) WHERE next_due_date IS NOT NULL;

DROP TRIGGER IF EXISTS trg_immunizations_updated_at ON public.immunizations;
CREATE TRIGGER trg_immunizations_updated_at BEFORE UPDATE ON public.immunizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.immunizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage immunizations" ON public.immunizations;
CREATE POLICY "Members manage immunizations" ON public.immunizations
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Structured per-member vaccine records with next-due tracking.
-- ============================================================
