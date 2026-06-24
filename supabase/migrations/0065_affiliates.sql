-- ============================================================
-- Migration 0065: Affiliate Management
-- Low-cost acquisition via partners who earn commission on conversions.
-- Distinct from the family Referral Program (#39, invite-a-friend rewards):
-- affiliates are external partners with a code + commission rate.
-- Service-role only (RLS ENABLED, NO policies), marketing-table convention.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.affiliates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  email           text,
  code            text NOT NULL UNIQUE,               -- ?via=CODE
  commission_rate numeric(5,4) NOT NULL DEFAULT 0.2000, -- 0.0000–1.0000
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_affiliates_status ON public.affiliates (status);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.affiliates;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.affiliates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.affiliate_referrals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id    uuid NOT NULL REFERENCES public.affiliates(id) ON DELETE CASCADE,
  referred_email  text,
  family_id       uuid REFERENCES public.families(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','converted','paid','void')),
  amount_cents    integer NOT NULL DEFAULT 0,         -- sale value at conversion
  commission_cents integer NOT NULL DEFAULT 0,        -- snapshot at conversion
  converted_at    timestamptz,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_affiliate ON public.affiliate_referrals (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_status ON public.affiliate_referrals (status);

ALTER TABLE public.affiliates          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_referrals ENABLE ROW LEVEL SECURITY;
