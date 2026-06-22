-- ============================================================
-- Migration 0054: CRM — contacts + sales pipeline (deals)
-- The cornerstone of the Bubaly marketing platform ("HubSpot competitor"): a
-- single source of truth for people (contacts) and revenue (deals/pipeline).
-- Business-wide marketing data → service-role only (RLS ENABLED, NO policies),
-- accessed via lib/marketing/admin.ts requireMarketingAdmin(). Mirrors the
-- 0013_marketing.sql convention.
-- ============================================================

-- ── Contacts (people: leads, prospects, customers) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name      text,
  last_name       text,
  email           text,
  phone           text,
  company         text,
  -- Pipeline status of the person as a lead.
  lead_status     text NOT NULL DEFAULT 'new'
                    CHECK (lead_status IN ('new','working','qualified','unqualified','customer')),
  -- Marketing lifecycle stage (subscriber → … → evangelist).
  lifecycle_stage text NOT NULL DEFAULT 'lead'
                    CHECK (lifecycle_stage IN ('subscriber','lead','mql','sql','opportunity','customer','evangelist')),
  lead_source     text,
  -- Optional link back to a Bubaly family (when a contact becomes a customer).
  family_id       uuid REFERENCES public.families(id) ON DELETE SET NULL,
  owner_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON public.crm_contacts (lower(email));
CREATE INDEX IF NOT EXISTS idx_crm_contacts_lifecycle ON public.crm_contacts (lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_status ON public.crm_contacts (lead_status);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.crm_contacts;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.crm_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Deals (sales pipeline / revenue) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_deals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  amount_cents integer NOT NULL DEFAULT 0,
  currency    text NOT NULL DEFAULT 'usd',
  -- Pipeline stage. 'won'/'lost' are terminal.
  stage       text NOT NULL DEFAULT 'lead'
                CHECK (stage IN ('lead','qualified','proposal','negotiation','won','lost')),
  close_date  date,
  owner_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes       text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON public.crm_deals (stage);
CREATE INDEX IF NOT EXISTS idx_crm_deals_contact ON public.crm_deals (contact_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.crm_deals;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.crm_deals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: service-role only (admin marketing data) ──────────────────────────
ALTER TABLE public.crm_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_deals    ENABLE ROW LEVEL SECURITY;
