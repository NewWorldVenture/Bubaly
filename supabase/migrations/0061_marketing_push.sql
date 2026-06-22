-- ============================================================
-- Migration 0061: Marketing Push Notifications — marketing_push_campaigns
-- Broadcast web/native push to opted-in devices (`push_devices`, mig 0035) via
-- the existing VAPID/FCM dispatch (lib/server/push.ts). Honors
-- `marketing_suppressions` (suppressed emails are excluded). Distinct from
-- transactional product notifications. Business-wide: RLS ENABLED, NO policies →
-- service-role only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_push_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text,
  url         text,
  segment_id  uuid REFERENCES public.marketing_segments(id) ON DELETE SET NULL, -- future targeting
  audience    text NOT NULL DEFAULT 'all_optedin' CHECK (audience IN ('all_optedin','segment')),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed')),
  recipients  integer NOT NULL DEFAULT 0,
  sent        integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  skipped     integer NOT NULL DEFAULT 0,
  clicked     integer NOT NULL DEFAULT 0,
  sent_at     timestamptz,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_push_status ON public.marketing_push_campaigns (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.marketing_push_campaigns;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.marketing_push_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketing_push_campaigns ENABLE ROW LEVEL SECURITY;
-- NO policies → service-role only (matches the marketing-table convention).
