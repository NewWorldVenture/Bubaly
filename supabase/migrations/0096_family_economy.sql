-- ============================================================================
-- Migration 0096: Family Economy — custom currencies (non-cash points/tokens)
-- ----------------------------------------------------------------------------
-- A parallel, NON-CASH economy: parents define their own currencies (e.g.
-- "Stars ⭐", "Screen-time minutes ⏰") that kids EARN (chores, manual awards)
-- and SPEND on family-defined rewards ("movie night pick", "30 min screen time").
-- Completely separate from the cash Family Wallet (0088) — no real money here.
--
-- Money model mirrors the wallet: an IMMUTABLE LEDGER. A member's balance in a
-- currency = sum of `currency_transactions` (credits − debits). Corrections are
-- new rows, never edits. All amounts are whole integers (tokens), >= 0.
-- Every table is family-scoped with is_family_member RLS.
-- ============================================================================

DO $$ BEGIN CREATE TYPE economy_direction AS ENUM ('credit','debit'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- redemption_status already exists from 0028 with ('requested','approved',
-- 'fulfilled','rejected'); the swallowed CREATE TYPE here silently left it
-- without the economy values, so DEFAULT 'pending' below could never apply.
-- Extend the existing enum idempotently instead (additive, non-breaking).
DO $$ BEGIN CREATE TYPE redemption_status AS ENUM ('pending','approved','fulfilled','rejected','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TYPE redemption_status ADD VALUE IF NOT EXISTS 'pending';
ALTER TYPE redemption_status ADD VALUE IF NOT EXISTS 'cancelled';

-- ---------- the custom currencies ----------
CREATE TABLE IF NOT EXISTS public.family_currencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,                 -- "Stars", "Screen-time minutes"
  emoji       text NOT NULL DEFAULT '⭐',     -- a single emoji shown as the token icon
  unit_label  text,                          -- optional singular unit, e.g. "minute"
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_currencies_family ON public.family_currencies (family_id, is_active, sort_order);

-- ---------- the immutable token ledger ----------
CREATE TABLE IF NOT EXISTS public.currency_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  currency_id   uuid NOT NULL REFERENCES public.family_currencies(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  direction     economy_direction NOT NULL,
  amount        bigint NOT NULL CHECK (amount > 0),   -- whole tokens, always positive; direction signs it
  reason        text,
  related_type  text,                                 -- chore_assignment | redemption | manual | reversal
  related_id    uuid,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_currency_txn_member ON public.currency_transactions (family_id, member_id, currency_id, created_at DESC);

-- ---------- the reward catalog (what tokens buy) ----------
CREATE TABLE IF NOT EXISTS public.economy_rewards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  currency_id uuid NOT NULL REFERENCES public.family_currencies(id) ON DELETE CASCADE,
  title       text NOT NULL,
  emoji       text NOT NULL DEFAULT '🎁',
  cost        bigint NOT NULL CHECK (cost > 0),
  stock       integer,                                -- null = unlimited
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_economy_rewards_family ON public.economy_rewards (family_id, is_active, sort_order);

-- ---------- redemptions (a child spends tokens on a reward) ----------
CREATE TABLE IF NOT EXISTS public.economy_redemptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  reward_id    uuid REFERENCES public.economy_rewards(id) ON DELETE SET NULL,
  currency_id  uuid NOT NULL REFERENCES public.family_currencies(id) ON DELETE CASCADE,
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  title        text NOT NULL,                         -- snapshot of the reward title
  cost         bigint NOT NULL CHECK (cost > 0),      -- snapshot of the cost
  status       redemption_status NOT NULL DEFAULT 'pending',
  txn_id       uuid REFERENCES public.currency_transactions(id) ON DELETE SET NULL, -- the debit, on approval
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_economy_redemptions_family ON public.economy_redemptions (family_id, status, created_at DESC);

-- ============================================================================
-- Family-scoped RLS + updated_at triggers.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY[
  'family_currencies','currency_transactions','economy_rewards','economy_redemptions'
];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))',
      t
    );
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t
    );
  END LOOP;
END $$;

-- ============================================================================
-- Done. Family Economy (custom non-cash currencies). Earn via credits, spend via
-- redemptions that debit on parent approval. Balances derived from the ledger.
-- ============================================================================
