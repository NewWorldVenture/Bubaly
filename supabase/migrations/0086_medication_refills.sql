-- ============================================================================
-- Migration 0086: Medication refill tracking — feeds the Family Autopilot
-- ----------------------------------------------------------------------------
-- Adds an optional refill date + lead-time to medications so the autopilot can
-- predict "refill due" before a family member runs out. Purely additive,
-- nullable columns — existing rows and RLS are unaffected.
-- ============================================================================

ALTER TABLE public.medications
  ADD COLUMN IF NOT EXISTS refill_on date,
  ADD COLUMN IF NOT EXISTS refill_reminder_days integer NOT NULL DEFAULT 7
    CHECK (refill_reminder_days >= 0);

CREATE INDEX IF NOT EXISTS idx_medications_refill ON public.medications (family_id, refill_on)
  WHERE refill_on IS NOT NULL;
