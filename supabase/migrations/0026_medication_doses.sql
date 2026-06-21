-- ============================================================
-- Migration 0026: Medication dose log (adherence tracking)
-- Backs the Medication Tracker. `medications` and
-- `medication_schedules` already exist (migration 0002); this adds a
-- per-dose log so adherence can be measured over time instead of only
-- tracking the last time a med was taken.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE dose_status AS ENUM ('taken', 'skipped', 'missed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.medication_doses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  medication_id uuid NOT NULL REFERENCES public.medications(id) ON DELETE CASCADE,
  schedule_id   uuid REFERENCES public.medication_schedules(id) ON DELETE SET NULL,
  member_id     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  -- The calendar day + scheduled time this dose belongs to. `scheduled_for`
  -- is the canonical slot; a (schedule_id, scheduled_for) pair is unique so a
  -- dose can be toggled idempotently from the UI.
  scheduled_for timestamptz NOT NULL,
  status        dose_status NOT NULL DEFAULT 'taken',
  taken_at      timestamptz,
  notes         text,
  logged_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_med_doses_family ON public.medication_doses(family_id);
CREATE INDEX IF NOT EXISTS idx_med_doses_med ON public.medication_doses(medication_id);
CREATE INDEX IF NOT EXISTS idx_med_doses_scheduled ON public.medication_doses(family_id, scheduled_for);
-- One row per scheduled slot so "mark taken/skip" is an idempotent upsert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_med_doses_slot
  ON public.medication_doses(schedule_id, scheduled_for)
  WHERE schedule_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.medication_doses;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.medication_doses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.medication_doses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage medication_doses" ON public.medication_doses;
CREATE POLICY "Members can manage medication_doses" ON public.medication_doses
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
