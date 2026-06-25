-- 0090_bubaly_money_stripe.sql
-- Bubaly Money — Stripe integration tables.
-- Adds Stripe Connect, capability cache, Issuing, Checkout, webhooks, and card controls.
-- Extends the virtual-ledger wallet (0088) with real-money Stripe backing when approved.
-- All tables are family-scoped with is_family_member() RLS (except admin/platform tables).
-- ⚠️ APPLY TO PROD after verifying against existing schema.

-- ─────────────────────────────────────────────────
-- STRIPE CUSTOMERS
-- Maps a Bubaly family to a Stripe Customer object.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id   text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Family member can read stripe_customers" ON public.stripe_customers;
CREATE POLICY "Family member can read stripe_customers" ON public.stripe_customers
  FOR SELECT TO authenticated USING (is_family_member(family_id));
DROP POLICY IF EXISTS "Family member can insert stripe_customers" ON public.stripe_customers;
CREATE POLICY "Family member can insert stripe_customers" ON public.stripe_customers
  FOR INSERT TO authenticated WITH CHECK (is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_stripe_customers_updated_at ON public.stripe_customers;
CREATE TRIGGER trg_stripe_customers_updated_at
  BEFORE UPDATE ON public.stripe_customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- STRIPE CONNECTED ACCOUNTS
-- One Connect Express account per family for real-money flows.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_connected_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL UNIQUE REFERENCES public.families(id) ON DELETE CASCADE,
  account_id          text NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','restricted','disabled')),
  charges_enabled     boolean NOT NULL DEFAULT false,
  payouts_enabled     boolean NOT NULL DEFAULT false,
  details_submitted   boolean NOT NULL DEFAULT false,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_connected_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Family member can read stripe_connected_accounts" ON public.stripe_connected_accounts;
CREATE POLICY "Family member can read stripe_connected_accounts" ON public.stripe_connected_accounts
  FOR SELECT TO authenticated USING (is_family_member(family_id));
DROP POLICY IF EXISTS "Family member can insert stripe_connected_accounts" ON public.stripe_connected_accounts;
CREATE POLICY "Family member can insert stripe_connected_accounts" ON public.stripe_connected_accounts
  FOR INSERT TO authenticated WITH CHECK (is_family_member(family_id));
DROP POLICY IF EXISTS "Family member can update stripe_connected_accounts" ON public.stripe_connected_accounts;
CREATE POLICY "Family member can update stripe_connected_accounts" ON public.stripe_connected_accounts
  FOR UPDATE TO authenticated USING (is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_stripe_connected_accounts_updated_at ON public.stripe_connected_accounts;
CREATE TRIGGER trg_stripe_connected_accounts_updated_at
  BEFORE UPDATE ON public.stripe_connected_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- STRIPE CAPABILITIES CACHE
-- Cached capability matrix per family, refreshed on demand.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_capabilities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL UNIQUE REFERENCES public.families(id) ON DELETE CASCADE,
  account_id          text,
  capability_matrix   jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at     timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_capabilities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Family member can read stripe_capabilities" ON public.stripe_capabilities;
CREATE POLICY "Family member can read stripe_capabilities" ON public.stripe_capabilities
  FOR SELECT TO authenticated USING (is_family_member(family_id));
DROP POLICY IF EXISTS "Family member can upsert stripe_capabilities" ON public.stripe_capabilities;
CREATE POLICY "Family member can upsert stripe_capabilities" ON public.stripe_capabilities
  FOR ALL TO authenticated USING (is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_stripe_capabilities_updated_at ON public.stripe_capabilities;
CREATE TRIGGER trg_stripe_capabilities_updated_at
  BEFORE UPDATE ON public.stripe_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- STRIPE FINANCIAL ACCOUNTS (Treasury)
-- One financial account per family when Treasury is enabled.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_financial_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  financial_account_id text NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  balance_usd_cents   bigint NOT NULL DEFAULT 0,
  currency            text NOT NULL DEFAULT 'usd',
  routing_number      text,
  account_number_last4 text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_financial_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Family member can read stripe_financial_accounts" ON public.stripe_financial_accounts;
CREATE POLICY "Family member can read stripe_financial_accounts" ON public.stripe_financial_accounts
  FOR SELECT TO authenticated USING (is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_stripe_financial_accounts_updated_at ON public.stripe_financial_accounts;
CREATE TRIGGER trg_stripe_financial_accounts_updated_at
  BEFORE UPDATE ON public.stripe_financial_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- STRIPE CHECKOUT SESSIONS
-- Track every Checkout session (gifts, top-ups) for reconciliation.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_checkout_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  session_id          text NOT NULL UNIQUE,
  type                text NOT NULL CHECK (type IN ('gift','topup','subscription')),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','expired')),
  amount_cents        integer NOT NULL,
  currency            text NOT NULL DEFAULT 'usd',
  related_id          text,   -- gift_payment_id, child_wallet_id, etc.
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  payment_intent_id   text,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_checkout_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Family member can read stripe_checkout_sessions" ON public.stripe_checkout_sessions;
CREATE POLICY "Family member can read stripe_checkout_sessions" ON public.stripe_checkout_sessions
  FOR SELECT TO authenticated USING (is_family_member(family_id));
DROP POLICY IF EXISTS "Family member can insert stripe_checkout_sessions" ON public.stripe_checkout_sessions;
CREATE POLICY "Family member can insert stripe_checkout_sessions" ON public.stripe_checkout_sessions
  FOR INSERT TO authenticated WITH CHECK (is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_stripe_checkout_sessions_updated_at ON public.stripe_checkout_sessions;
CREATE TRIGGER trg_stripe_checkout_sessions_updated_at
  BEFORE UPDATE ON public.stripe_checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- STRIPE CARDHOLDERS (Issuing)
-- One cardholder per family / parent Stripe account.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_cardholders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  cardholder_id   text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_cardholders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Family member can read stripe_cardholders" ON public.stripe_cardholders;
CREATE POLICY "Family member can read stripe_cardholders" ON public.stripe_cardholders
  FOR SELECT TO authenticated USING (is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_stripe_cardholders_updated_at ON public.stripe_cardholders;
CREATE TRIGGER trg_stripe_cardholders_updated_at
  BEFORE UPDATE ON public.stripe_cardholders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- STRIPE ISSUING CARDS
-- Virtual and physical cards per child wallet.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_issuing_cards (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id                   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id             uuid REFERENCES public.child_wallets(id) ON DELETE SET NULL,
  card_id                     text NOT NULL UNIQUE,
  cardholder_id               text NOT NULL,
  type                        text NOT NULL CHECK (type IN ('virtual','physical')),
  status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','canceled')),
  last4                       text,
  exp_month                   integer,
  exp_year                    integer,
  brand                       text,
  personalization_design_id   text,
  shipping_status             text,
  created_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_issuing_cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Family member can read stripe_issuing_cards" ON public.stripe_issuing_cards;
CREATE POLICY "Family member can read stripe_issuing_cards" ON public.stripe_issuing_cards
  FOR SELECT TO authenticated USING (is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_stripe_issuing_cards_updated_at ON public.stripe_issuing_cards;
CREATE TRIGGER trg_stripe_issuing_cards_updated_at
  BEFORE UPDATE ON public.stripe_issuing_cards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- STRIPE AUTHORIZATIONS
-- Real-time card authorization log (issuing_authorization.request webhook).
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_authorizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  authorization_id text NOT NULL UNIQUE,
  card_id         text NOT NULL,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE SET NULL,
  status          text NOT NULL CHECK (status IN ('pending','approved','declined','reversed','closed')),
  decision        text CHECK (decision IN ('approved','declined')),
  decline_reason  text,
  amount_cents    integer NOT NULL,
  currency        text NOT NULL DEFAULT 'usd',
  merchant_name   text,
  merchant_category text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  authorized_at   timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_authorizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Family member can read stripe_authorizations" ON public.stripe_authorizations;
CREATE POLICY "Family member can read stripe_authorizations" ON public.stripe_authorizations
  FOR SELECT TO authenticated USING (is_family_member(family_id));

-- ─────────────────────────────────────────────────
-- STRIPE WEBHOOK EVENTS
-- Raw event log for auditability and retry. Global table (admin-only reads).
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        text NOT NULL UNIQUE,
  type            text NOT NULL,
  livemode        boolean NOT NULL DEFAULT false,
  api_version     text,
  family_id       uuid REFERENCES public.families(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed','skipped')),
  error           text,
  processed_at    timestamptz,
  raw_payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role can manage stripe_webhook_events" ON public.stripe_webhook_events;
CREATE POLICY "Service role can manage stripe_webhook_events" ON public.stripe_webhook_events
  FOR ALL TO service_role USING (true);
-- Admins can read webhook events for debugging
DROP POLICY IF EXISTS "Authenticated read stripe_webhook_events" ON public.stripe_webhook_events;
CREATE POLICY "Authenticated read stripe_webhook_events" ON public.stripe_webhook_events
  FOR SELECT TO authenticated USING (true);

-- ─────────────────────────────────────────────────
-- CARD CONTROLS
-- Per-card spending limits and merchant category controls.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.card_controls (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id                       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  card_id                         text NOT NULL UNIQUE,
  daily_limit_cents               integer,
  weekly_limit_cents              integer,
  monthly_limit_cents             integer,
  per_txn_limit_cents             integer,
  allow_online                    boolean NOT NULL DEFAULT true,
  allow_in_store                  boolean NOT NULL DEFAULT true,
  allow_atm                       boolean NOT NULL DEFAULT false,
  blocked_categories              text[] NOT NULL DEFAULT '{}',
  parent_approval_threshold_cents integer,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.card_controls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Family member can read card_controls" ON public.card_controls;
CREATE POLICY "Family member can read card_controls" ON public.card_controls
  FOR SELECT TO authenticated USING (is_family_member(family_id));
DROP POLICY IF EXISTS "Family member can write card_controls" ON public.card_controls;
CREATE POLICY "Family member can write card_controls" ON public.card_controls
  FOR ALL TO authenticated USING (is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_card_controls_updated_at ON public.card_controls;
CREATE TRIGGER trg_card_controls_updated_at
  BEFORE UPDATE ON public.card_controls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- CARD DESIGNS
-- Admin-managed card design library (Stripe personalization design IDs).
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.card_designs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  description             text,
  stripe_design_id        text,   -- Stripe personalization_design ID when available
  preview_url             text,
  is_active               boolean NOT NULL DEFAULT true,
  requires_physical       boolean NOT NULL DEFAULT false,
  sort_order              integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.card_designs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read card_designs" ON public.card_designs;
CREATE POLICY "Authenticated read card_designs" ON public.card_designs
  FOR SELECT TO authenticated USING (is_active = true);
DROP TRIGGER IF EXISTS trg_card_designs_updated_at ON public.card_designs;
CREATE TRIGGER trg_card_designs_updated_at
  BEFORE UPDATE ON public.card_designs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Seed default card designs
INSERT INTO public.card_designs (name, description, is_active, requires_physical, sort_order) VALUES
  ('Bubaly Classic',   'Our signature family-friendly design',    true, false, 1),
  ('Bubaly Stars',     'Playful stars design for younger kids',    true, false, 2),
  ('Bubaly Nature',    'Calm nature theme',                        true, false, 3),
  ('Bubaly Adventure', 'Bold adventure design for teens',          true, false, 4)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────
-- STRIPE FEATURE FLAGS (extend existing feature_flags)
-- ─────────────────────────────────────────────────
INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('stripe_checkout_enabled',    false, 'Stripe Checkout for gifts and top-ups'),
  ('stripe_real_auth_enabled',   false, 'Stripe Issuing real-time authorization webhook'),
  ('stripe_instant_payout',      false, 'Stripe instant payout to parent bank account'),
  ('bubaly_money_enabled',       true,  'Master toggle for Bubaly Money (virtual ledger always on)'),
  ('babysitter_payments_enabled', true,  'Babysitter payment tracking'),
  ('card_designs_enabled',       false, 'Custom card designs via Stripe personalization')
ON CONFLICT (key) DO NOTHING;
