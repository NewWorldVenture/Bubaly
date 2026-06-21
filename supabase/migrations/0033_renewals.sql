-- ============================================================
-- Migration 0033: Renewals & Expirations tracker
-- Backs the Renewals tracker (Top-50 complaints #30 "household documents
-- expire → AI expiration management" and #31 "appliance warranties
-- forgotten → AI warranty manager"). Tracks anything that expires and
-- needs renewing — IDs, licenses, registrations, warranties, insurance,
-- subscriptions — each with its own reminder lead time.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE renewal_status AS ENUM ('active', 'renewed', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.renewals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title         text NOT NULL,
  category      text,                 -- id / passport / license / registration / warranty / insurance / subscription / other
  expires_at    date NOT NULL,
  -- How many days before expiry this should start warning.
  reminder_days integer NOT NULL DEFAULT 30,
  cost          numeric(10,2),
  url           text,
  status        renewal_status NOT NULL DEFAULT 'active',
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_renewals_family ON public.renewals(family_id);
CREATE INDEX IF NOT EXISTS idx_renewals_expiry ON public.renewals(family_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_renewals_member ON public.renewals(member_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.renewals;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.renewals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.renewals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage renewals" ON public.renewals;
CREATE POLICY "Members can manage renewals" ON public.renewals
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
