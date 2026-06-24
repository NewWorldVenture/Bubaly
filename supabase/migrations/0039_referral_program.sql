-- ============================================================
-- Migration 0039: Referral Program (viral growth loop)
-- Each family gets a unique referral code/link. When a referred family signs
-- up and converts to a paid plan, both sides earn a reward credit.
--
-- referral_codes  — one code per family (family-scoped, family-readable).
-- referrals       — the tracked referral relationship + reward state.
--
-- Reads are family-scoped via the standard is_family_member() model so a family
-- can see the people it referred (and the credit it earned). All WRITES happen
-- through the service-role client (signup attribution, admin, Stripe webhook),
-- so there are deliberately no INSERT/UPDATE/DELETE policies.
-- ============================================================

-- ---------- Referral codes (one per family) ----------
CREATE TABLE IF NOT EXISTS public.referral_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL UNIQUE REFERENCES public.families(id) ON DELETE CASCADE,
  code        text NOT NULL UNIQUE,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON public.referral_codes (code);

DROP TRIGGER IF EXISTS trg_referral_codes_updated_at ON public.referral_codes;
CREATE TRIGGER trg_referral_codes_updated_at
  BEFORE UPDATE ON public.referral_codes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;

-- A family can read its own code. Writes are service-role only.
DROP POLICY IF EXISTS referral_codes_select ON public.referral_codes;
CREATE POLICY referral_codes_select ON public.referral_codes
  FOR SELECT USING (public.is_family_member(family_id));

-- ---------- Referrals (the tracked relationship) ----------
CREATE TABLE IF NOT EXISTS public.referrals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL,
  referrer_family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  referred_family_id    uuid REFERENCES public.families(id) ON DELETE SET NULL,
  referred_email        text,
  status                text NOT NULL DEFAULT 'signed_up'
                          CHECK (status IN ('pending','signed_up','converted','rewarded','void')),
  source                text,
  referrer_reward_cents integer NOT NULL DEFAULT 0 CHECK (referrer_reward_cents >= 0),
  referred_reward_cents integer NOT NULL DEFAULT 0 CHECK (referred_reward_cents >= 0),
  signed_up_at          timestamptz NOT NULL DEFAULT now(),
  converted_at          timestamptz,
  rewarded_at           timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- A family can only be referred once, and never by itself.
  CONSTRAINT referrals_referred_once UNIQUE (referred_family_id),
  CONSTRAINT referrals_no_self CHECK (referred_family_id IS NULL OR referred_family_id <> referrer_family_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON public.referrals (referrer_family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON public.referrals (referred_family_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status   ON public.referrals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_code     ON public.referrals (code);

DROP TRIGGER IF EXISTS trg_referrals_updated_at ON public.referrals;
CREATE TRIGGER trg_referrals_updated_at
  BEFORE UPDATE ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

-- Both the referrer and the referred family can read the referral. Writes are
-- service-role only (attribution + reward crediting happen server-side).
DROP POLICY IF EXISTS referrals_select ON public.referrals;
CREATE POLICY referrals_select ON public.referrals
  FOR SELECT USING (
    public.is_family_member(referrer_family_id)
    OR (referred_family_id IS NOT NULL AND public.is_family_member(referred_family_id))
  );

-- ============================================================
-- Done! Families can refer friends and earn rewards on conversion.
-- ============================================================
