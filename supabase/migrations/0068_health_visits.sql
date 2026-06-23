-- ============================================================
-- Migration 0068: Health Visits log (medical · dental · vaccination · vision · …)
-- A structured visit/encounter history per family member — the backbone of a
-- world-class family medical/dental record. Captures who, when, with whom, why,
-- the outcome, follow-up date, and cost. Powers the medical + dental hubs and a
-- unified "Visits & History" view. Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE health_visit_kind AS ENUM
    ('medical','dental','vision','mental_health','specialist','vaccination','therapy','urgent_care','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.health_visits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  provider_id     uuid REFERENCES public.health_providers(id) ON DELETE SET NULL,
  kind            health_visit_kind NOT NULL DEFAULT 'medical',
  title           text NOT NULL,
  provider_name   text,
  location        text,
  visit_date      date NOT NULL DEFAULT current_date,
  reason          text,
  outcome         text,                -- diagnosis / what happened / notes
  follow_up_date  date,
  cost_cents      integer CHECK (cost_cents IS NULL OR cost_cents >= 0),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_visits_family ON public.health_visits (family_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_health_visits_member ON public.health_visits (family_id, member_id);
CREATE INDEX IF NOT EXISTS idx_health_visits_followup ON public.health_visits (family_id, follow_up_date) WHERE follow_up_date IS NOT NULL;

DROP TRIGGER IF EXISTS trg_health_visits_updated_at ON public.health_visits;
CREATE TRIGGER trg_health_visits_updated_at BEFORE UPDATE ON public.health_visits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.health_visits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage health_visits" ON public.health_visits;
CREATE POLICY "Members manage health_visits" ON public.health_visits
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Structured medical/dental/vaccination visit history per member.
-- ============================================================
