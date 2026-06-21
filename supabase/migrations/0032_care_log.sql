-- ============================================================
-- Migration 0032: Caregiver / Elder care log
-- Backs the Care Log (Top-50 complaint #25 "elder care difficult → AI
-- caregiver dashboard"). A timeline of check-ins, visits, calls, and
-- well-being notes for a family member who needs coordinated care, so
-- the whole family can see who last checked in and how they're doing.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE care_log_type AS ENUM ('check_in', 'visit', 'call', 'meal', 'medication', 'appointment', 'incident', 'note');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.care_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  -- The person being cared for.
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  log_type     care_log_type NOT NULL DEFAULT 'check_in',
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  -- Optional 1–5 well-being rating recorded at the time.
  wellbeing    smallint CHECK (wellbeing BETWEEN 1 AND 5),
  note         text,
  -- The family member who performed/recorded the care.
  logged_by    uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_care_log_family ON public.care_log(family_id);
CREATE INDEX IF NOT EXISTS idx_care_log_member ON public.care_log(family_id, member_id, occurred_at DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.care_log;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.care_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.care_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage care_log" ON public.care_log;
CREATE POLICY "Members can manage care_log" ON public.care_log
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
