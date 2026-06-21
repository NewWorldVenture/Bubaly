-- ============================================================
-- Migration 0031: Registrations & Signups tracker
-- Backs the Signups tracker (Top-50 complaints #27 "school
-- registrations missed → AI registration monitoring" and #28 "camp
-- signups fill up → AI opportunity alerts"). Time-boxed opportunities
-- (camp/school/sports/activity registrations) with a deadline and a
-- simple status workflow so nothing fills up or closes unnoticed.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE opportunity_status AS ENUM ('interested', 'registered', 'waitlisted', 'passed', 'missed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.opportunities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title       text NOT NULL,
  category    text,                 -- camp / school / sports / activity / class / other
  url         text,
  cost        numeric(10,2),
  opens_at    date,                 -- registration opens
  deadline    date,                 -- registration closes
  status      opportunity_status NOT NULL DEFAULT 'interested',
  notes       text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunities_family ON public.opportunities(family_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_deadline ON public.opportunities(family_id, deadline);
CREATE INDEX IF NOT EXISTS idx_opportunities_member ON public.opportunities(member_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.opportunities;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.opportunities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage opportunities" ON public.opportunities;
CREATE POLICY "Members can manage opportunities" ON public.opportunities
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
