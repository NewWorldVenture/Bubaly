-- ============================================================
-- Migration 0052: Family onboarding details
-- Captures the "About your family" step of the customer onboarding journey:
-- household makeup, location, goals, and how they heard about Bubaly. One row
-- per family. This is family-owned data (the family can read/edit its own), and
-- the marketing platform reads it business-wide via the service role for
-- segmentation/personalization.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.family_onboarding (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id          uuid NOT NULL UNIQUE REFERENCES public.families(id) ON DELETE CASCADE,
  household_adults   integer NOT NULL DEFAULT 1 CHECK (household_adults >= 0 AND household_adults <= 20),
  household_children integer NOT NULL DEFAULT 0 CHECK (household_children >= 0 AND household_children <= 20),
  child_ages         integer[] NOT NULL DEFAULT '{}',
  region             text,                       -- state / province
  postal_code        text,
  country            text,
  goals              text[] NOT NULL DEFAULT '{}',  -- chores, calendar, meals, budget, …
  referral_source    text CHECK (referral_source IS NULL OR referral_source IN
                       ('search','friend_family','social','app_store','blog','ad','podcast','other')),
  referral_detail    text,
  completed_at       timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_onboarding_referral ON public.family_onboarding (referral_source);

DROP TRIGGER IF EXISTS trg_family_onboarding_updated_at ON public.family_onboarding;
CREATE TRIGGER trg_family_onboarding_updated_at BEFORE UPDATE ON public.family_onboarding
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
-- A family reads/writes its own onboarding row. Marketing reads via service role.
ALTER TABLE public.family_onboarding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS family_onboarding_all ON public.family_onboarding;
CREATE POLICY family_onboarding_all ON public.family_onboarding
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
