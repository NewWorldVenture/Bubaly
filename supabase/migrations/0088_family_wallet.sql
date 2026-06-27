-- ============================================================================
-- Migration 0088: Bubaly Family Wallet — virtual-ledger MVP
-- ----------------------------------------------------------------------------
-- The financial operating system for families. This migration builds the
-- PARENT-CONTROLLED, virtual-ledger foundation that works WITHOUT Stripe
-- Treasury/Issuing approval (the required MVP mode). Stripe-backed money
-- movement + card issuing plug into this ledger in a later phase.
--
-- Money model = an IMMUTABLE LEDGER: balances are derived by summing
-- `wallet_transactions`. Corrections are made with `reversal` rows that point at
-- the original via `reverses_id` — historical amounts/types are never edited.
-- Every table is family-scoped with is_family_member RLS (feature_flags is the
-- one global table). All amounts are integer cents.
-- ============================================================================

-- ---------- enums ----------
DO $$ BEGIN CREATE TYPE wallet_mode AS ENUM ('ledger','treasury'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wallet_bucket_kind AS ENUM ('spend','save','give','invest','goal'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wallet_txn_type AS ENUM (
  'gift_received','parent_top_up','allowance','chore_reward','babysitter_payment',
  'card_spend','card_refund','goal_transfer','bucket_transfer','withdrawal','fee','adjustment','reversal'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wallet_txn_status AS ENUM (
  'pending','requires_parent_approval','processing','completed','failed','reversed','cancelled'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wallet_txn_direction AS ENUM ('credit','debit'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE allowance_cadence AS ENUM ('weekly','biweekly','monthly'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE approval_status AS ENUM ('pending','approved','rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- the parent-controlled family wallet ----------
CREATE TABLE IF NOT EXISTS public.family_wallets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  currency      text NOT NULL DEFAULT 'usd',
  mode          wallet_mode NOT NULL DEFAULT 'ledger',
  is_active     boolean NOT NULL DEFAULT true,
  -- compliance: parent/guardian must accept disclosures before activation
  disclosures_accepted_at timestamptz,
  disclosures_accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id)
);

-- ---------- one wallet per child ----------
CREATE TABLE IF NOT EXISTS public.child_wallets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_child_wallets_family ON public.child_wallets (family_id, is_active);

-- ---------- buckets (Spend / Save / Give / Invest / Goal) ----------
CREATE TABLE IF NOT EXISTS public.wallet_buckets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid NOT NULL REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  kind            wallet_bucket_kind NOT NULL,
  label           text NOT NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (child_wallet_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_wallet_buckets_child ON public.wallet_buckets (family_id, child_wallet_id, sort_order);

-- ---------- the immutable ledger ----------
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  bucket_id       uuid REFERENCES public.wallet_buckets(id) ON DELETE SET NULL,
  type            wallet_txn_type NOT NULL,
  status          wallet_txn_status NOT NULL DEFAULT 'completed',
  direction       wallet_txn_direction NOT NULL,           -- credit = into wallet, debit = out
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  currency        text NOT NULL DEFAULT 'usd',
  description     text,
  related_type    text,                                    -- e.g. chore_assignment | gift_payment | allowance_rule
  related_id      uuid,
  reverses_id     uuid REFERENCES public.wallet_transactions(id) ON DELETE SET NULL, -- set on reversal rows
  stripe_ref      text,                                    -- payment_intent / transfer id when Stripe-backed
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_txn_child ON public.wallet_transactions (family_id, child_wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_txn_status ON public.wallet_transactions (family_id, status);
CREATE INDEX IF NOT EXISTS idx_wallet_txn_bucket ON public.wallet_transactions (bucket_id);

-- ---------- allocation + approval rules ----------
CREATE TABLE IF NOT EXISTS public.wallet_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE, -- null = family default
  -- split percentages summing to 100, e.g. {"spend":30,"save":50,"give":10,"invest":10}
  split           jsonb NOT NULL DEFAULT '{"spend":40,"save":40,"give":10,"invest":10}',
  auto_accept_gifts boolean NOT NULL DEFAULT false,
  require_approval_over_cents bigint NOT NULL DEFAULT 5000 CHECK (require_approval_over_cents >= 0),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, child_wallet_id)
);

-- ---------- savings goals ----------
CREATE TABLE IF NOT EXISTS public.wallet_goals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE, -- null = shared/family goal
  title           text NOT NULL,
  kind            text NOT NULL DEFAULT 'custom',          -- bike | college | car | vacation | giving | emergency | custom
  target_cents    bigint NOT NULL CHECK (target_cents >= 0),
  saved_cents     bigint NOT NULL DEFAULT 0 CHECK (saved_cents >= 0),
  target_date     date,
  status          text NOT NULL DEFAULT 'active',          -- active | reached | archived
  image_url       text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_goals_family ON public.wallet_goals (family_id, status);

-- ---------- grandparent / relative gifting ----------
CREATE TABLE IF NOT EXISTS public.gift_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  token           text NOT NULL,                           -- public share token
  occasion        text,                                    -- birthday | holiday | graduation | just_because
  message         text,
  suggested_cents integer[] NOT NULL DEFAULT '{2500,5000,10000}',
  is_active       boolean NOT NULL DEFAULT true,
  expires_at      timestamptz,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS idx_gift_links_family ON public.gift_links (family_id, is_active);

CREATE TABLE IF NOT EXISTS public.gift_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  gift_link_id    uuid REFERENCES public.gift_links(id) ON DELETE SET NULL,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  giver_name      text,
  giver_email     text,
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  message         text,
  occasion        text,
  status          wallet_txn_status NOT NULL DEFAULT 'pending',
  stripe_ref      text,                                    -- checkout session / payment intent
  applied_txn_id  uuid REFERENCES public.wallet_transactions(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gift_payments_family ON public.gift_payments (family_id, status, created_at DESC);

-- ---------- allowance automation ----------
CREATE TABLE IF NOT EXISTS public.allowance_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid NOT NULL REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  cadence         allowance_cadence NOT NULL DEFAULT 'weekly',
  split           jsonb,                                   -- optional per-rule override of wallet_rules.split
  is_active       boolean NOT NULL DEFAULT true,
  next_run_on     date,
  last_run_on     date,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allowance_rules_due ON public.allowance_rules (is_active, next_run_on);

-- ---------- babysitter payments ----------
CREATE TABLE IF NOT EXISTS public.babysitter_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text,
  email       text,
  rate_cents  bigint CHECK (rate_cents IS NULL OR rate_cents >= 0),
  notes       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_babysitter_profiles_family ON public.babysitter_profiles (family_id, is_active);

CREATE TABLE IF NOT EXISTS public.babysitter_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  babysitter_id uuid REFERENCES public.babysitter_profiles(id) ON DELETE SET NULL,
  event_id      uuid REFERENCES public.calendar_events(id) ON DELETE SET NULL,
  hours         numeric(5,2) CHECK (hours IS NULL OR hours >= 0),
  rate_cents    bigint CHECK (rate_cents IS NULL OR rate_cents >= 0),
  tip_cents     bigint NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),
  status        wallet_txn_status NOT NULL DEFAULT 'pending',
  stripe_ref    text,
  receipt_url   text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_babysitter_payments_family ON public.babysitter_payments (family_id, status, created_at DESC);

-- ---------- parent approvals (gifts/chores/spend above threshold) ----------
CREATE TABLE IF NOT EXISTS public.parent_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind          text NOT NULL,                             -- gift | chore_reward | card_spend | withdrawal
  ref_type      text,
  ref_id        uuid,
  amount_cents  bigint,
  status        approval_status NOT NULL DEFAULT 'pending',
  requested_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_parent_approvals_family ON public.parent_approvals (family_id, status, created_at DESC);

-- ---------- audit + compliance ----------
CREATE TABLE IF NOT EXISTS public.wallet_audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  entity_type   text,
  entity_id     uuid,
  detail        text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_audit_family ON public.wallet_audit_logs (family_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.compliance_disclosures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind          text NOT NULL,                             -- wallet_terms | card_terms | treasury | issuing | fees
  version       text NOT NULL,
  accepted_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  ip_address    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_family ON public.compliance_disclosures (family_id, kind);

-- ============================================================================
-- Family-scoped RLS + updated_at triggers for every wallet table.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY[
  'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules',
  'wallet_goals','gift_links','gift_payments','allowance_rules','babysitter_profiles',
  'babysitter_payments','parent_approvals','wallet_audit_logs','compliance_disclosures'
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
-- Global feature flags (NOT family-scoped). Readable by any authenticated user;
-- writes happen via service role / admin tooling. Gates the Stripe phases so the
-- app runs in virtual-ledger MVP mode until Treasury/Issuing are approved.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.feature_flags (
  key         text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT false,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read feature_flags" ON public.feature_flags;
CREATE POLICY "Authenticated read feature_flags" ON public.feature_flags FOR SELECT TO authenticated USING (true);
DROP TRIGGER IF EXISTS trg_feature_flags_updated_at ON public.feature_flags;
CREATE TRIGGER trg_feature_flags_updated_at BEFORE UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('wallet_virtual_ledger_enabled', true,  'Virtual-ledger Family Wallet (no Stripe required)'),
  ('stripe_payments_enabled',       false, 'Stripe Checkout for gifts/top-ups'),
  ('stripe_connect_enabled',        false, 'Stripe Connect parent onboarding'),
  ('stripe_treasury_enabled',       false, 'Stripe Treasury embedded financial accounts (needs approval)'),
  ('stripe_issuing_enabled',        false, 'Stripe Issuing virtual/physical cards (needs approval)'),
  ('physical_cards_enabled',        false, 'Order physical debit/prepaid cards'),
  ('custom_card_designs_enabled',   false, 'Custom Bubaly card designs (needs Stripe review)'),
  ('babysitter_payments_enabled',   true,  'Babysitter payment tracking + receipts'),
  ('grandparent_gifting_enabled',   true,  'Gift links + grandparent gifting'),
  ('ai_wallet_coach_enabled',       true,  'AI Family Financial Coach')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Done! The Bubaly Family Wallet virtual-ledger foundation (14 family tables +
-- global feature flags). Stripe tables (customers/connected_accounts/financial_
-- accounts/cardholders/issuing_cards/authorizations/card_controls/card_designs/
-- webhook_events) arrive in the Stripe phase — see docs/AGENT_HANDOFF.md.
-- ============================================================================
