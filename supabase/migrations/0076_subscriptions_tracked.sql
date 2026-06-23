-- ============================================================
-- Migration 0076: Subscription Tracking — subscriptions_tracked
-- Track recurring paid services (streaming, apps, memberships): cost, cadence,
-- next charge, last-used. Powers "reduce waste" insights — normalised monthly /
-- annual spend and stale/unused subscription flags. Family-scoped RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.subscriptions_tracked (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  cost_cents  integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  cadence     text NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('weekly','monthly','quarterly','yearly')),
  category    text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','trial','paused','canceled')),
  next_charge date,
  last_used   date,
  note        text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tracked_family ON public.subscriptions_tracked (family_id, status);

DROP TRIGGER IF EXISTS trg_subscriptions_tracked_updated ON public.subscriptions_tracked;
CREATE TRIGGER trg_subscriptions_tracked_updated BEFORE UPDATE ON public.subscriptions_tracked
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.subscriptions_tracked ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage subscriptions_tracked" ON public.subscriptions_tracked;
CREATE POLICY "Members manage subscriptions_tracked" ON public.subscriptions_tracked
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
