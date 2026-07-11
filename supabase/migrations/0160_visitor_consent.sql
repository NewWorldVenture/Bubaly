-- ============================================================================
-- 0160 · Visitor consent layer (privacy-first).
--
-- The visitor-intelligence spine (mkt_visitors / mkt_sessions / mkt_touchpoints,
-- 0058) records first-party analytics keyed by an anonymous id, but had NO
-- consent model — so /api/mkt/track wrote regardless of the visitor's choice.
-- This adds an APPEND-ONLY consent ledger: every grant/revoke is one immutable,
-- timestamped, versioned row keyed by the anonymous id (and the CRM contact once
-- identified). Current state = the latest row per (anonymous_id, category), so a
-- later 'denied' revokes and the full history is auditable.
--
-- Categories: necessary (always on) · analytics · personalization ·
-- marketing_email · marketing_sms. GPC/Do-Not-Sell is honored at read time.
--
-- Service-role only (RLS ENABLED, NO policies) — mirrors the mkt_ convention;
-- written by /api/mkt/consent and read by /api/mkt/track. Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.mkt_consent_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anonymous_id  text NOT NULL,
  contact_id    uuid REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  category      text NOT NULL CHECK (category IN
                  ('necessary','analytics','personalization','marketing_email','marketing_sms')),
  decision      text NOT NULL CHECK (decision IN ('granted','denied')),
  policy_version text NOT NULL DEFAULT 'v1',
  source        text,          -- banner | preference_center | signup | api | gpc
  gpc           boolean NOT NULL DEFAULT false,
  user_agent    text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Latest-per-category lookups by visitor, and contact rollups.
CREATE INDEX IF NOT EXISTS idx_mkt_consent_anon
  ON public.mkt_consent_events (anonymous_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_consent_contact
  ON public.mkt_consent_events (contact_id, created_at DESC);

ALTER TABLE public.mkt_consent_events ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only (like mkt_visitors / mkt_sessions / mkt_touchpoints).
