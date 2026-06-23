-- ============================================================
-- Migration 0067: Track scheduled cancellation on subscriptions
-- Adds cancel_at_period_end so the billing UI can show "cancels on <date>"
-- (a downgrade to Free scheduled for period end) and offer a one-tap Resume.
-- Kept in sync by the Stripe webhook (customer.subscription.updated).
-- ============================================================

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;
