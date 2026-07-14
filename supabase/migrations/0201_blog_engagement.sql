-- ============================================================================
-- Migration 0201: Blog engagement — hero images, hearts, subscribers
-- The public blog grows from a read-only page into an engaging surface:
--   • blog_posts gains hero image columns (free-license Unsplash CDN photos,
--     rendered via next/image; credit stored for good form).
--   • blog_post_likes — anonymous ♥ per visitor (bubaly_vid), one per
--     post+visitor. Service-role only (the /api/blog/like route validates and
--     writes); no client policies → RLS denies direct access.
--   • blog_subscribers — email opt-ins from the blog subscribe forms, with an
--     unsubscribe token + status so consent can be revoked. Service-role only.
-- Additive + idempotent.
-- ============================================================================

ALTER TABLE public.blog_posts ADD COLUMN IF NOT EXISTS hero_image_url    text;
ALTER TABLE public.blog_posts ADD COLUMN IF NOT EXISTS hero_image_alt    text;
ALTER TABLE public.blog_posts ADD COLUMN IF NOT EXISTS hero_image_credit text;

-- ── Hearts ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blog_post_likes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  visitor_id text NOT NULL CHECK (char_length(visitor_id) BETWEEN 8 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_blog_post_likes_post ON public.blog_post_likes (post_id);

ALTER TABLE public.blog_post_likes ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only (the like API is the single write/read path).

-- ── Subscribers ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blog_subscribers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL UNIQUE CHECK (position('@' in email) > 1),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unsubscribed')),
  source            text NOT NULL DEFAULT 'blog',
  visitor_id        text,
  unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_blog_subscribers_status ON public.blog_subscribers (status);

DROP TRIGGER IF EXISTS trg_blog_subscribers_updated_at ON public.blog_subscribers;
CREATE TRIGGER trg_blog_subscribers_updated_at
  BEFORE UPDATE ON public.blog_subscribers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.blog_subscribers ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only (the subscribe API is the single write path).
