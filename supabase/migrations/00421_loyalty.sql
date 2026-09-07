-- ============================================================
-- Migration 0042: Loyalty & Rewards — Marketing Pillar 3
-- A points-based loyalty program for customer families: earn points (signup,
-- referral, review, spend, manual), climb tiers, and redeem from a rewards
-- catalog. Pairs with Referrals (Pillar shipped) and Reviews (Pillar 2).
--
-- loyalty_settings     — singleton program config (earn rules + tier thresholds).
-- loyalty_rewards      — the redeemable catalog (admin-defined).
-- loyalty_accounts     — one per family: balance + lifetime + tier.
-- loyalty_transactions — the points ledger (signed, with running balance_after).
-- loyalty_redemptions  — a redeemed reward + fulfillment state.
--
-- A family can READ its own account/ledger/redemptions and the active catalog
-- (the same model as Referrals). All point mutations happen through the
-- service-role engine (lib/loyalty/server.ts): admin actions + the redeem action,
-- so balances can never be tampered with client-side. Hence no client write
-- policies; settings/redemption writes are service-role only.
-- ============================================================

-- ---------- Program settings (singleton) ----------
CREATE TABLE IF NOT EXISTS public.loyalty_settings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton         boolean NOT NULL DEFAULT true UNIQUE,
  enabled           boolean NOT NULL DEFAULT false,
  program_name      text NOT NULL DEFAULT 'Bubaly Rewards',
  points_label      text NOT NULL DEFAULT 'points',
  earn_signup       integer NOT NULL DEFAULT 100,
  earn_referral     integer NOT NULL DEFAULT 500,
  earn_review       integer NOT NULL DEFAULT 50,
  earn_per_dollar   numeric(6,2) NOT NULL DEFAULT 1,
  tier_silver_at    integer NOT NULL DEFAULT 1000,
  tier_gold_at      integer NOT NULL DEFAULT 5000,
  updated_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------- Rewards catalog ----------
CREATE TABLE IF NOT EXISTS public.loyalty_rewards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  cost_points  integer NOT NULL CHECK (cost_points >= 0),
  kind         text NOT NULL DEFAULT 'credit'
                 CHECK (kind IN ('credit','free_month','discount','swag','donation','custom')),
  value_cents  integer,
  image_url    text,
  stock        integer,                       -- NULL = unlimited
  is_active    boolean NOT NULL DEFAULT true,
  sort         integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_active ON public.loyalty_rewards (is_active, sort);

-- ---------- Per-family account ----------
CREATE TABLE IF NOT EXISTS public.loyalty_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL UNIQUE REFERENCES public.families(id) ON DELETE CASCADE,
  points_balance  integer NOT NULL DEFAULT 0,
  lifetime_points integer NOT NULL DEFAULT 0,
  tier            text NOT NULL DEFAULT 'bronze',
  joined_at       timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- Points ledger ----------
CREATE TABLE IF NOT EXISTS public.loyalty_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  points        integer NOT NULL,             -- signed: +earn / -redeem
  kind          text NOT NULL DEFAULT 'earn'
                  CHECK (kind IN ('earn','redeem','adjust','expire')),
  reason        text,
  source        text,                         -- signup | referral | review | purchase | manual | redemption
  balance_after integer NOT NULL DEFAULT 0,
  reward_id     uuid REFERENCES public.loyalty_rewards(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_family ON public.loyalty_transactions (family_id, created_at DESC);

-- ---------- Redemptions ----------
CREATE TABLE IF NOT EXISTS public.loyalty_redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  reward_id     uuid REFERENCES public.loyalty_rewards(id) ON DELETE SET NULL,
  reward_name   text NOT NULL,
  cost_points   integer NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','fulfilled','cancelled')),
  code          text,
  fulfilled_at  timestamptz,
  fulfilled_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_family ON public.loyalty_redemptions (family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_status ON public.loyalty_redemptions (status, created_at DESC);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['loyalty_settings','loyalty_rewards','loyalty_accounts','loyalty_transactions','loyalty_redemptions'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- RLS ----------
ALTER TABLE public.loyalty_settings ENABLE ROW LEVEL SECURITY;     -- service-role only
ALTER TABLE public.loyalty_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_redemptions ENABLE ROW LEVEL SECURITY;

-- Catalog is readable by any authenticated user (families browse rewards).
DROP POLICY IF EXISTS loyalty_rewards_read ON public.loyalty_rewards;
CREATE POLICY loyalty_rewards_read ON public.loyalty_rewards
  FOR SELECT USING (auth.role() = 'authenticated');

-- A family can read its own account, ledger, and redemptions. All writes are
-- service-role (admin actions + the redeem engine), so no write policies.
DROP POLICY IF EXISTS loyalty_accounts_select ON public.loyalty_accounts;
CREATE POLICY loyalty_accounts_select ON public.loyalty_accounts
  FOR SELECT USING (public.is_family_member(family_id));

DROP POLICY IF EXISTS loyalty_transactions_select ON public.loyalty_transactions;
CREATE POLICY loyalty_transactions_select ON public.loyalty_transactions
  FOR SELECT USING (public.is_family_member(family_id));

DROP POLICY IF EXISTS loyalty_redemptions_select ON public.loyalty_redemptions;
CREATE POLICY loyalty_redemptions_select ON public.loyalty_redemptions
  FOR SELECT USING (public.is_family_member(family_id));
