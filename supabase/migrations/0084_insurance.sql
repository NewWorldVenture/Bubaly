-- ============================================================
-- Migration 0084: Family Insurance Hub — family_insurance_policies
-- One unified home for EVERY household policy (health, auto, home, life, …),
-- distinct from the existing per-domain tables (medical insurance_policies =
-- health cards, auto_insurance_policies = vehicle, home warranties). Powers the
-- AI insurance-awareness engine: renewals, annualized premium spend, coverage
-- gaps. Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.insurance_policy_type AS ENUM
    ('health','dental','vision','auto','home','renters','life','disability','umbrella','pet','travel','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.premium_frequency AS ENUM
    ('monthly','quarterly','semiannual','annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.family_insurance_policies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  policy_type       public.insurance_policy_type NOT NULL DEFAULT 'other',
  insurer           text NOT NULL,
  policy_number     text,
  member_id         uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  premium_amount    numeric(12,2),
  premium_frequency public.premium_frequency NOT NULL DEFAULT 'monthly',
  coverage_amount   numeric(14,2),
  deductible        numeric(12,2),
  effective_date    date,
  renewal_date      date,
  agent_name        text,
  agent_phone       text,
  claim_phone       text,
  document_path     text,
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_insurance_family ON public.family_insurance_policies (family_id, is_active);
CREATE INDEX IF NOT EXISTS idx_family_insurance_renewal ON public.family_insurance_policies (family_id, renewal_date) WHERE renewal_date IS NOT NULL;

DROP TRIGGER IF EXISTS trg_family_insurance_updated ON public.family_insurance_policies;
CREATE TRIGGER trg_family_insurance_updated BEFORE UPDATE ON public.family_insurance_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_insurance_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage family_insurance_policies" ON public.family_insurance_policies;
CREATE POLICY "Members manage family_insurance_policies" ON public.family_insurance_policies
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! One unified household insurance ledger with renewal dates + premiums.
-- ============================================================
