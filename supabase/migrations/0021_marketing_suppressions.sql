-- ============================================================
-- Migration 0021: Marketing email suppressions
-- Honors unsubscribes, bounces, and spam complaints. Anyone in this table is
-- excluded from marketing sends. Same security model: RLS enabled, no policies
-- (admin/service-role only). The unsubscribe route writes here via the service
-- role; the Resend webhook adds bounces/complaints.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_suppressions (
  email       text PRIMARY KEY,
  reason      text NOT NULL DEFAULT 'unsubscribe'
                CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual')),
  campaign_id uuid REFERENCES public.marketing_email_campaigns(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.marketing_suppressions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Suppressed addresses are excluded from all marketing sends.
-- ============================================================
