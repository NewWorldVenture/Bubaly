-- ============================================================================
-- Migration 0235: Real hero photos for the batch-2 articles
-- The batch-2 posts (0234) shipped with NO hero URL and rendered the generated
-- <BlogCover>, so on the live grid many looked visually identical. This gives
-- every image-less published article a REAL, free (CC0) Lorem Picsum photo —
-- the same CC0 source the batch-1 hero photos use as their fallback. The URL is
-- keyed to the post's slug via the seed endpoint, which ALWAYS resolves (no
-- 404s) and is unique per slug.
--
-- HONEST SCOPE: per-article topic curation (like the batch-1 Wikimedia photos)
-- is not possible from the build environment — every external image source
-- (Wikimedia, Openverse, image CDNs) is network-blocked here — so these are
-- real, professional, free photos but not hand-matched to each article's topic,
-- and a minority may visually repeat because Picsum's catalog is finite. When
-- image-source access (or an Unsplash/Pexels API key) is available, this can be
-- upgraded to unique, topic-matched photos via the batch-1 hero-photos pattern.
--
-- Idempotent: only fills posts that still have NULL hero_image_url; free-license
-- covers already assigned (Wikimedia/Picsum on batch 1) are left untouched.
-- Requires 0234 (batch-2 posts).
-- ============================================================================

UPDATE public.blog_posts
SET
  hero_image_url    = 'https://picsum.photos/seed/' || slug || '/1600/900',
  hero_image_alt    = 'Editorial photograph accompanying: ' || title,
  hero_image_credit = 'Lorem Picsum (CC0)'
WHERE published
  AND hero_image_url IS NULL
  AND slug NOT LIKE 'seed-blog_posts-%';
