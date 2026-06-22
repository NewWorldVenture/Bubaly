-- ============================================================
-- Migration 0051: checkout session tracking (abandoned-checkout automation)
-- To fire the event-driven `checkout_abandoned` workflow (#88 deferred this as
-- it needs delayed detection), we record every Stripe Checkout session we open.
-- The webhook marks it completed; a daily cron sweeps sessions still 'pending'
-- past a grace window and fires the workflow, then marks them 'abandoned' so it
-- never re-fires. Billing infra: service-role only (RLS on, no policies) — rows
-- are written by the checkout route + webhook and read by the cron.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.checkout_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   text NOT NULL UNIQUE,          -- Stripe Checkout Session id
  family_id    uuid REFERENCES public.families(id) ON DELETE CASCADE,
  email        text,
  name         text,
  plan         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'abandoned')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  abandoned_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status ON public.checkout_sessions (status, created_at);

-- Service-role only: no policies. The checkout route + Stripe webhook (service
-- client) write; the cron reads. Never exposed to client/anon.
ALTER TABLE public.checkout_sessions ENABLE ROW LEVEL SECURITY;
