-- ============================================================================
-- Migration 0090: Bubaly Money — Stripe Financial Mode (Connect/Treasury/Issuing)
-- ----------------------------------------------------------------------------
-- Phase 2 of the Family Wallet. Adds the Stripe-backed money layer that plugs
-- INTO the immutable ledger from 0088 — it never replaces it. The ledger remains
-- the single source of truth for balances; Stripe rows here just record the
-- external account/card/authorization identifiers and mirror their lifecycle.
--
-- These tables stay dormant until the matching feature_flags are switched on
-- (stripe_connect_enabled / stripe_treasury_enabled / stripe_issuing_enabled).
-- Until then the app runs in virtual-ledger mode and none of this is touched.
--
-- SECURITY: no card numbers, no bank account numbers, no PII beyond what Stripe
-- requires us to hold by reference. We store Stripe object IDs + status only.
-- Family tables are is_family_member RLS; stripe_webhook_events is service-role
-- only (RLS enabled, no policy) since it is written exclusively by the webhook.
-- ============================================================================

DO $$ BEGIN CREATE TYPE stripe_account_status AS ENUM ('pending','restricted','enabled','disabled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE stripe_card_type AS ENUM ('virtual','physical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE stripe_card_status AS ENUM ('pending','active','inactive','canceled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE stripe_auth_outcome AS ENUM ('approved','declined'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Connect: parent/guardian onboarding (KYC) ----------
-- One connected account per family. Required before Treasury/Issuing. We store
-- the account id + the capability/requirement state Stripe reports back.
CREATE TABLE IF NOT EXISTS public.stripe_connected_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id          uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  stripe_account_id  text NOT NULL,
  status             stripe_account_status NOT NULL DEFAULT 'pending',
  charges_enabled    boolean NOT NULL DEFAULT false,
  payouts_enabled    boolean NOT NULL DEFAULT false,
  details_submitted  boolean NOT NULL DEFAULT false,
  treasury_enabled   boolean NOT NULL DEFAULT false,   -- Treasury capability active
  card_issuing_enabled boolean NOT NULL DEFAULT false, -- Issuing capability active
  requirements_due   jsonb NOT NULL DEFAULT '[]',      -- currently_due / past_due summary
  onboarded_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id),
  UNIQUE (stripe_account_id)
);

-- ---------- Treasury: embedded financial account ----------
CREATE TABLE IF NOT EXISTS public.stripe_financial_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id            uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  connected_account_id uuid NOT NULL REFERENCES public.stripe_connected_accounts(id) ON DELETE CASCADE,
  stripe_financial_account_id text NOT NULL,
  status               text NOT NULL DEFAULT 'open',
  -- Cached balance for display only; the ledger remains the source of truth.
  cached_balance_cents bigint NOT NULL DEFAULT 0,
  cached_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id),
  UNIQUE (stripe_financial_account_id)
);

-- ---------- Issuing: one cardholder per child member ----------
CREATE TABLE IF NOT EXISTS public.stripe_cardholders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id            uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id            uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  child_wallet_id      uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  stripe_cardholder_id text NOT NULL,
  status               text NOT NULL DEFAULT 'active',
  created_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, member_id),
  UNIQUE (stripe_cardholder_id)
);

-- ---------- Issuing: the cards (virtual + physical) ----------
-- We never store the PAN. last4/brand/exp are non-sensitive display fields Stripe
-- returns and are safe to cache. Full card details are fetched ephemerally via
-- Stripe.js when a parent reveals them — never persisted.
CREATE TABLE IF NOT EXISTS public.stripe_issuing_cards (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id   uuid NOT NULL REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  cardholder_id     uuid NOT NULL REFERENCES public.stripe_cardholders(id) ON DELETE CASCADE,
  stripe_card_id    text NOT NULL,
  type              stripe_card_type NOT NULL DEFAULT 'virtual',
  status            stripe_card_status NOT NULL DEFAULT 'active',
  last4             text,
  brand             text,
  exp_month         integer,
  exp_year          integer,
  design_id         uuid,                              -- optional custom design
  -- spending controls (parent-set), mirrored to Stripe spending_controls
  spend_limit_cents bigint CHECK (spend_limit_cents IS NULL OR spend_limit_cents >= 0),
  spend_window      text NOT NULL DEFAULT 'per_authorization', -- per_authorization|daily|weekly|monthly|all_time
  blocked_categories text[] NOT NULL DEFAULT '{}',     -- merchant categories the child cannot use
  is_frozen         boolean NOT NULL DEFAULT false,    -- parent "freeze card" toggle
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_card_id)
);
CREATE INDEX IF NOT EXISTS idx_issuing_cards_family ON public.stripe_issuing_cards (family_id, child_wallet_id);

-- ---------- Issuing: real-time authorization log ----------
-- Every authorization request the webhook approves/declines is recorded here for
-- audit + the activity feed. The actual money effect lives in wallet_transactions
-- (a card_spend debit on capture); this table is the Stripe-side record.
CREATE TABLE IF NOT EXISTS public.stripe_authorizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id             uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  card_id               uuid REFERENCES public.stripe_issuing_cards(id) ON DELETE SET NULL,
  child_wallet_id       uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  stripe_authorization_id text NOT NULL,
  amount_cents          bigint NOT NULL DEFAULT 0,
  merchant_name         text,
  merchant_category     text,
  outcome               stripe_auth_outcome NOT NULL,
  decline_reason        text,                          -- why we declined (insufficient_spend, frozen, blocked_category…)
  txn_id                uuid REFERENCES public.wallet_transactions(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_authorization_id)
);
CREATE INDEX IF NOT EXISTS idx_authorizations_family ON public.stripe_authorizations (family_id, created_at DESC);

-- ============================================================================
-- Family-scoped RLS + updated_at triggers (read-only for members; all writes go
-- through service-role server code so card/treasury state can't be forged client
-- side). We grant SELECT to members and restrict INSERT/UPDATE/DELETE to service.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY[
  'stripe_connected_accounts','stripe_financial_accounts','stripe_cardholders',
  'stripe_issuing_cards','stripe_authorizations'
];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- Members can READ their family's Stripe state (to render the Money pages).
    EXECUTE format('DROP POLICY IF EXISTS "Members read %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Members read %1$s" ON public.%1$I FOR SELECT TO authenticated USING (public.is_family_member(family_id))',
      t
    );
    -- No INSERT/UPDATE/DELETE policy → only the service role can write. This is
    -- deliberate: financial state is mutated exclusively by trusted server code.
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t
    );
  END LOOP;
END $$;

-- ---------- Custom card designs (global catalog, admin-managed) ----------
CREATE TABLE IF NOT EXISTS public.stripe_card_designs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text,
  preview_url   text,
  stripe_personalization_design_id text,  -- Stripe personalization_design id when reviewed/approved
  status        text NOT NULL DEFAULT 'draft', -- draft | review | active | rejected
  is_active     boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_card_designs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read card designs" ON public.stripe_card_designs;
CREATE POLICY "Authenticated read card designs" ON public.stripe_card_designs
  FOR SELECT TO authenticated USING (is_active = true);
DROP TRIGGER IF EXISTS trg_stripe_card_designs_updated_at ON public.stripe_card_designs;
CREATE TRIGGER trg_stripe_card_designs_updated_at BEFORE UPDATE ON public.stripe_card_designs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- Webhook idempotency log (service-role only) ----------
-- Every Stripe event id is recorded here BEFORE processing. A duplicate delivery
-- (Stripe retries) is detected by the unique constraint and skipped. RLS is on
-- with NO policy, so it is invisible to clients and writable only by service role.
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL,
  type          text NOT NULL,
  status        text NOT NULL DEFAULT 'processed', -- processed | error
  error         text,
  payload_summary jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_event_id)
);
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type ON public.stripe_webhook_events (type, created_at DESC);

-- ============================================================================
-- Done. Stripe Financial Mode schema. Dormant until the stripe_* feature_flags
-- are enabled. See lib/stripe/capabilities.ts for the capability-detection layer
-- that decides ledger vs Stripe mode at runtime.
-- ============================================================================
