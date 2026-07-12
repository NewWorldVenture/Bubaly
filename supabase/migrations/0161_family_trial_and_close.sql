-- ============================================================================
-- 0161 · 5-day free trial + soft account closure on families.
--
-- New monetization model: a NEW family gets 5 days of full Family Basic access,
-- then the account locks until they buy Family Basic or Family+ (no permanent
-- free tier). EXISTING families are grandfathered — their free access continues.
--
-- Grandfathering is structural, not a hardcoded date: `trial_ends_at` is added
-- with NO default first (every existing row becomes NULL = grandfathered = never
-- locked), and only THEN given a `now() + 5 days` default, which applies to
-- future inserts only. So existing families keep working and only families
-- created after this migration get a trial clock.
--
-- `closed_at` powers soft account closure: the account is hidden/locked but
-- NOTHING is deleted, so the family can return and reopen. Additive + idempotent.
-- ============================================================================

ALTER TABLE public.families ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE public.families ADD COLUMN IF NOT EXISTS closed_at     timestamptz;

-- Default applies to NEW rows only (existing rows keep their NULL from ADD COLUMN
-- above → grandfathered). Re-running just re-sets the same default (no-op).
ALTER TABLE public.families ALTER COLUMN trial_ends_at SET DEFAULT (now() + interval '5 days');

CREATE INDEX IF NOT EXISTS idx_families_trial_ends_at ON public.families (trial_ends_at);
CREATE INDEX IF NOT EXISTS idx_families_closed_at     ON public.families (closed_at);
