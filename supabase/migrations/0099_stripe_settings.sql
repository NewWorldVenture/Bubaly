-- Stripe Setup — a single, super-admin-configurable home for the Bubaly Stripe
-- account and the per-transaction service fee paid to Bubaly. One row
-- ('singleton'). Locked down: RLS on with NO policies, so only the service role
-- (the super-admin server actions) can read/write it — secrets never reach the
-- browser via PostgREST.

CREATE TABLE IF NOT EXISTS stripe_settings (
  id                   TEXT        PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  enabled              BOOLEAN     NOT NULL DEFAULT false,
  publishable_key      TEXT,
  secret_key           TEXT,
  webhook_secret       TEXT,
  connect_account_id   TEXT,
  -- The Bubaly service fee added to transactions (cents). Default $0.90.
  service_fee_cents    INTEGER     NOT NULL DEFAULT 90 CHECK (service_fee_cents >= 0),
  -- A one-time Stripe Price (in the Bubaly account) for the service fee, added
  -- to subscription checkouts via add_invoice_items so the fee lands on Bubaly.
  service_fee_price_id TEXT,
  updated_by           UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stripe_settings_updated_at') THEN
    CREATE TRIGGER stripe_settings_updated_at BEFORE UPDATE ON stripe_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE stripe_settings ENABLE ROW LEVEL SECURITY;
-- (No policies on purpose: service-role only.)

INSERT INTO stripe_settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;
