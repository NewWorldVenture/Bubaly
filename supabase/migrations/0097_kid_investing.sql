-- ============================================================================
-- Migration 0097: AI Investing for kids — EDUCATIONAL, SIMULATED investing
-- ----------------------------------------------------------------------------
-- A teaching tool, NOT a brokerage. Kids "invest" the cash in their wallet's
-- INVEST bucket (0088) into simulated educational assets to learn how markets,
-- diversification and compound growth work. There is NO real trading, NO real
-- securities, NO guaranteed returns. Prices are simulated/educational.
--
-- Money discipline: a "buy" moves cash OUT of the child's invest bucket (a
-- wallet_transactions debit) and records shares in invest_holdings; a "sell"
-- moves cash back IN. The wallet ledger stays the source of truth for cash.
-- Orders require parent approval. Family-scoped RLS; the asset catalog is global.
-- ============================================================================

DO $$ BEGIN CREATE TYPE invest_order_side AS ENUM ('buy','sell'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE invest_order_status AS ENUM ('pending','filled','rejected','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- educational asset catalog (global, simulated prices) ----------
CREATE TABLE IF NOT EXISTS public.invest_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol       text NOT NULL,                 -- short code, e.g. "MARKET", "TECH"
  name         text NOT NULL,                 -- "US Stock Market (Index)"
  kind         text NOT NULL DEFAULT 'fund',  -- fund | stocks | bonds | basket
  emoji        text NOT NULL DEFAULT '📈',
  description  text,
  price_cents  bigint NOT NULL CHECK (price_cents > 0),  -- simulated current price / share
  risk_level   text NOT NULL DEFAULT 'medium',           -- low | medium | high (educational)
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol)
);
ALTER TABLE public.invest_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read invest_assets" ON public.invest_assets;
CREATE POLICY "Authenticated read invest_assets" ON public.invest_assets FOR SELECT TO authenticated USING (is_active = true);
DROP TRIGGER IF EXISTS trg_invest_assets_updated_at ON public.invest_assets;
CREATE TRIGGER trg_invest_assets_updated_at BEFORE UPDATE ON public.invest_assets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A small starter set of EDUCATIONAL, non-real assets (generic baskets, not
-- tradeable securities) so the experience works out of the box.
INSERT INTO public.invest_assets (symbol, name, kind, emoji, description, price_cents, risk_level, sort_order) VALUES
  ('MARKET', 'US Stock Market (Index)', 'fund',   '🏦', 'A simulated basket of the whole stock market — the classic “buy a little of everything” idea.', 5000, 'medium', 1),
  ('TECH',   'Technology Companies',    'basket', '💻', 'A simulated basket of tech companies. Higher ups and downs.', 8000, 'high', 2),
  ('GREEN',  'Clean Energy',            'basket', '🌱', 'A simulated basket of clean-energy companies.', 3000, 'high', 3),
  ('BONDS',  'Government Bonds',        'bonds',  '🛡️', 'A simulated safe, steady saver. Lower risk, lower growth.', 2000, 'low', 4),
  ('GOLD',   'Gold',                    'basket', '🪙', 'A simulated store of value that moves differently from stocks.', 6000, 'medium', 5)
ON CONFLICT (symbol) DO NOTHING;

-- ---------- a child's simulated holdings ----------
CREATE TABLE IF NOT EXISTS public.invest_holdings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid NOT NULL REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  asset_id        uuid NOT NULL REFERENCES public.invest_assets(id) ON DELETE CASCADE,
  shares          numeric(16,4) NOT NULL DEFAULT 0 CHECK (shares >= 0),
  avg_cost_cents  bigint NOT NULL DEFAULT 0 CHECK (avg_cost_cents >= 0),  -- avg paid per share
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (child_wallet_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_invest_holdings_family ON public.invest_holdings (family_id, child_wallet_id);

-- ---------- orders (buy/sell), parent-approved ----------
CREATE TABLE IF NOT EXISTS public.invest_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid NOT NULL REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  asset_id        uuid NOT NULL REFERENCES public.invest_assets(id) ON DELETE CASCADE,
  side            invest_order_side NOT NULL,
  shares          numeric(16,4) NOT NULL CHECK (shares > 0),
  price_cents     bigint NOT NULL CHECK (price_cents > 0),   -- snapshot at order time
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),  -- shares * price (rounded)
  status          invest_order_status NOT NULL DEFAULT 'pending',
  txn_id          uuid REFERENCES public.wallet_transactions(id) ON DELETE SET NULL,
  requested_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invest_orders_family ON public.invest_orders (family_id, status, created_at DESC);

-- ============================================================================
-- Family-scoped RLS + updated_at triggers for holdings + orders.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['invest_holdings','invest_orders'];
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
-- Done. Educational, simulated kid investing. Buys/sells move cash through the
-- wallet's INVEST bucket; holdings track shares. Parent-approved. No real money
-- leaves the wallet — this is a learning tool only.
-- ============================================================================
