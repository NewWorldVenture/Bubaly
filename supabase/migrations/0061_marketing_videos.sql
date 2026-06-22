-- ============================================================
-- Migration 0061: Video Marketing — marketing_videos
-- Catalog of marketing videos (YouTube / Vimeo embeds or uploaded files from the
-- Asset Library). Transcripts feed AEO/SEO; published videos embed in content +
-- landing pages. Business-wide: RLS ENABLED, NO policies → service-role only.
-- Uploaded videos reference an object in the private "marketing-assets" bucket
-- (created in 0058); external videos store provider + video_id + url.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_videos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  provider         text NOT NULL DEFAULT 'youtube' CHECK (provider IN ('youtube','vimeo','upload')),
  video_id         text,        -- external id for youtube/vimeo
  url              text,        -- original source url (youtube/vimeo)
  storage_path     text,        -- for provider='upload' (marketing-assets bucket)
  poster_url       text,
  captions_url     text,
  transcript       text,
  duration_seconds integer,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  tags             text[] NOT NULL DEFAULT '{}',
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_videos_status ON public.marketing_videos (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.marketing_videos;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.marketing_videos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketing_videos ENABLE ROW LEVEL SECURITY;
-- NO policies → service-role only (matches the marketing-table convention).
