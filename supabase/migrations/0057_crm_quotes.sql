-- ============================================================
-- Migration 0057: Proposals / Quotes (Sales & Revenue pillar)
-- Converts qualified leads into customers — a quote tied to a CRM contact (and
-- optionally a deal), with a status lifecycle and an expiry. Service-role only
-- (RLS ENABLED, NO policies), per the marketing-table convention.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.crm_quotes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  deal_id      uuid REFERENCES public.crm_deals(id) ON DELETE SET NULL,
  title        text NOT NULL,
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','sent','accepted','declined','expired')),
  amount_cents integer NOT NULL DEFAULT 0,
  currency     text NOT NULL DEFAULT 'usd',
  valid_until  date,
  notes        text,
  sent_at      timestamptz,
  responded_at timestamptz,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_quotes_status ON public.crm_quotes (status);
CREATE INDEX IF NOT EXISTS idx_crm_quotes_contact ON public.crm_quotes (contact_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.crm_quotes;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.crm_quotes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.crm_quotes ENABLE ROW LEVEL SECURITY;
