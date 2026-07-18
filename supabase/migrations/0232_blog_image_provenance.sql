-- ============================================================================
-- Migration 0232: Blog image provenance and source-level deduplication
--
-- The public blog stores hero images on blog_posts rather than in the private
-- marketing asset library. Keep that public surface under the same provenance
-- contract: every image must declare a known free-use license, attribution,
-- source URL, and a stable source hash. The trigger makes future admin edits
-- fail closed; the unique indexes prevent reusing one source for two posts.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS hero_image_source_url text,
  ADD COLUMN IF NOT EXISTS hero_image_license text,
  ADD COLUMN IF NOT EXISTS hero_image_attribution text,
  ADD COLUMN IF NOT EXISTS hero_image_source_hash text;

CREATE OR REPLACE FUNCTION public.blog_image_license(credit text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  value text := lower(btrim(coalesce(credit, '')));
BEGIN
  IF value = '' THEN RETURN NULL; END IF;
  IF value ~ 'cc0' THEN RETURN 'cc0'; END IF;
  IF value ~ 'public domain|no restrictions' THEN RETURN 'public_domain'; END IF;
  IF value ~ 'cc by-sa' THEN RETURN 'cc_by_sa'; END IF;
  IF value ~ 'cc by' THEN RETURN 'cc_by'; END IF;
  IF value ~ 'unsplash' THEN RETURN 'unsplash'; END IF;
  IF value ~ 'original' THEN RETURN 'original'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_blog_image_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  normalized_url text;
  normalized_license text;
BEGIN
  normalized_url := nullif(btrim(NEW.hero_image_url), '');
  IF normalized_url IS NULL THEN
    NEW.hero_image_source_url := NULL;
    NEW.hero_image_license := NULL;
    NEW.hero_image_attribution := NULL;
    NEW.hero_image_source_hash := NULL;
    RETURN NEW;
  END IF;

  IF normalized_url !~* '^https://' THEN
    RAISE EXCEPTION 'Blog hero images must use an HTTPS source URL.';
  END IF;

  IF nullif(btrim(NEW.hero_image_credit), '') IS NULL THEN
    RAISE EXCEPTION 'Blog hero images require attribution.';
  END IF;

  normalized_license := public.blog_image_license(NEW.hero_image_credit);
  IF normalized_license IS NULL THEN
    RAISE EXCEPTION 'Blog hero image credit does not identify an approved free-use license: %', NEW.hero_image_credit;
  END IF;

  NEW.hero_image_url := normalized_url;
  NEW.hero_image_source_url := normalized_url;
  NEW.hero_image_license := normalized_license;
  NEW.hero_image_attribution := btrim(NEW.hero_image_credit);
  NEW.hero_image_source_hash := encode(digest(normalized_url, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_blog_image_provenance ON public.blog_posts;
CREATE TRIGGER trg_blog_image_provenance
  BEFORE INSERT OR UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.sync_blog_image_provenance();

-- Backfill the reviewed legacy image rows through the same mapping used for
-- future writes. The following guard makes the migration fail rather than
-- silently publishing an image whose license cannot be identified.
UPDATE public.blog_posts
SET hero_image_source_url = nullif(btrim(hero_image_url), ''),
    hero_image_license = public.blog_image_license(hero_image_credit),
    hero_image_attribution = nullif(btrim(hero_image_credit), ''),
    hero_image_source_hash = CASE
      WHEN nullif(btrim(hero_image_url), '') IS NULL THEN NULL
      ELSE encode(digest(btrim(hero_image_url), 'sha256'), 'hex')
    END
WHERE hero_image_url IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.blog_posts
    WHERE hero_image_url IS NOT NULL
      AND (hero_image_source_url IS NULL OR hero_image_license IS NULL
        OR hero_image_attribution IS NULL OR hero_image_source_hash IS NULL)
  ) THEN
    RAISE EXCEPTION 'Blog image provenance backfill found an incomplete or unlicensed hero image.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_blog_posts_hero_image_source_url
  ON public.blog_posts(hero_image_source_url)
  WHERE hero_image_source_url IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_blog_posts_hero_image_source_hash
  ON public.blog_posts(hero_image_source_hash)
  WHERE hero_image_source_hash IS NOT NULL;

COMMENT ON COLUMN public.blog_posts.hero_image_license IS
  'Approved free-use license normalized from hero_image_credit.';
COMMENT ON COLUMN public.blog_posts.hero_image_source_hash IS
  'SHA-256 hash of the canonical source URL; unique source-level deduplication key.';
