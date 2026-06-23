-- ============================================================
-- Migration 0060: Asset Library (DAM) — marketing_assets + private bucket
-- A central digital-asset manager for the marketing OS: images, video, docs and
-- brand files, reusable by Email / Social / Content / Landing pickers.
-- Business-wide (NOT family-scoped): RLS ENABLED, NO policies → service-role only.
-- Files live in a PRIVATE storage bucket with no storage.objects policies, so the
-- service role is the only reader/writer (admin pages mint short-lived signed URLs).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'image' CHECK (kind IN ('image','video','document','brand')),
  storage_path text NOT NULL,
  mime_type    text,
  size_bytes   bigint,
  width        integer,
  height       integer,
  alt_text     text,
  tags         text[] NOT NULL DEFAULT '{}',
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_assets_kind ON public.marketing_assets (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_assets_tags ON public.marketing_assets USING gin (tags);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.marketing_assets;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.marketing_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketing_assets ENABLE ROW LEVEL SECURITY;
-- NO policies → service-role only (matches the marketing-table convention).

-- Private "marketing-assets" Storage bucket. No storage.objects policies are
-- created, so only the service role can read/write; the admin console mints
-- short-lived signed URLs for previews. 50 MB per file.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('marketing-assets', 'marketing-assets', false, 52428800)
ON CONFLICT (id) DO NOTHING;
