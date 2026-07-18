-- ============================================================================
-- Migration 0231: Drop LoremFlickr cover URLs from blog_posts
-- The 500-article blog seed (0226) pinned every post's hero_image_url to
-- loremflickr.com — a placeholder proxy that serves MIXED-license Flickr photos
-- (attribution-required / All-Rights-Reserved possible, not verified free) drawn
-- from only 9 keyword pools (so covers were also visually duplicated). The app no
-- longer renders these (they are stripped at the data layer in lib/blog/posts.ts,
-- and image-less posts render a bespoke generated <BlogCover>), but leaving
-- unverified-license URLs in the production database is undesirable for a public
-- marketing surface. This nulls them out at the source so the DB stores zero
-- unverified-license image URLs. See docs/MARKETING_PLATFORM_COORDINATION.md §6c
-- and LB-016 / PLA-0831.
--
-- Idempotent + non-destructive: only touches rows whose hero still points at
-- loremflickr; free-licensed covers (Unsplash) and real uploads are untouched.
-- No schema change, no data loss (the covers were third-party hotlinks, not
-- owned assets); posts simply fall back to their generated cover.
-- ============================================================================

update public.blog_posts
set
  hero_image_url = null,
  hero_image_alt = null,
  hero_image_credit = null
where hero_image_url like '%loremflickr.com%';
