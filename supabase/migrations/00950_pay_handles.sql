-- ============================================================================
-- Migration 0095: Pay-ID handles — memorable gifting links (e.g. bubaly.com/pay/mia)
-- ----------------------------------------------------------------------------
-- A Pay-ID is a short, human-friendly handle a family claims for a child (or the
-- whole family). Visiting /pay/<handle> resolves to that child's active gift link
-- so relatives don't have to copy a long random token. Handles are stored already
-- normalized (lowercase, [a-z0-9_]) and are globally UNIQUE.
--
-- No money lives here — this is just a friendly alias that redirects to the
-- existing gift_links flow. Family-scoped RLS for management; the public resolver
-- route reads via the service role.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pay_handles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,  -- null = family-level handle
  handle          text NOT NULL,                                              -- normalized: lowercase [a-z0-9_], 3-20
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_handles_format CHECK (handle ~ '^[a-z0-9_]{3,20}$')
);

-- Globally unique handle (the whole point of a Pay-ID).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_handles_handle ON public.pay_handles (handle);
CREATE INDEX IF NOT EXISTS idx_pay_handles_family ON public.pay_handles (family_id, is_active);

ALTER TABLE public.pay_handles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage pay_handles" ON public.pay_handles;
CREATE POLICY "Members manage pay_handles" ON public.pay_handles
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

DROP TRIGGER IF EXISTS trg_pay_handles_updated_at ON public.pay_handles;
CREATE TRIGGER trg_pay_handles_updated_at BEFORE UPDATE ON public.pay_handles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Done. Pay-ID handles. The public /pay/<handle> route resolves via the service
-- role and redirects to the child's newest active gift link.
-- ============================================================================
