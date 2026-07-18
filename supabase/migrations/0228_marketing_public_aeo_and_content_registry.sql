-- ============================================================================
-- Migration 0228: Close the marketing loop — public AEO reads + blog registry
--
--   (1) PUBLIC AEO READ. marketing_aeo_questions was service-role-only. The
--       public site (FAQ / Knowledge Center + per-article FAQ blocks + FAQPage
--       structured data) must render the SAME answers the admin AEO console
--       manages — so published questions become world-readable (published rows
--       only; drafts/opportunities stay admin-only). This makes the admin AEO
--       page the single source that automatically feeds every public page.
--
--   (2) CONTENT REGISTRY. Every published blog post is registered as a
--       marketing_content_item (kind='blog', status='published') so the whole
--       blog is listed + wired in /admin/marketing/content. Idempotent: keyed
--       by metadata->>'slug', re-running never duplicates. Synthetic seed rows
--       are excluded (they never render publicly).
-- Additive + idempotent.
-- ============================================================================

-- (1) Published AEO questions are public content -----------------------------
DROP POLICY IF EXISTS marketing_aeo_public_read ON public.marketing_aeo_questions;
CREATE POLICY marketing_aeo_public_read ON public.marketing_aeo_questions
  FOR SELECT TO anon, authenticated
  USING (status = 'published');

GRANT SELECT ON public.marketing_aeo_questions TO anon, authenticated;

-- (2) Register every published blog post as a content item -------------------
INSERT INTO public.marketing_content_items (title, kind, channel, brief, status, publish_at, metadata)
SELECT
  b.title,
  'blog',
  'blog',
  b.excerpt,
  'published',
  b.published_at::timestamptz,
  jsonb_build_object(
    'slug', b.slug,
    'category', b.category,
    'source', 'blog_posts',
    'url', '/blog/' || b.slug,
    'tags', to_jsonb(b.tags)
  )
FROM public.blog_posts b
WHERE b.published
  AND b.slug NOT LIKE 'seed-blog_posts-%'
  AND NOT EXISTS (
    SELECT 1 FROM public.marketing_content_items c
    WHERE c.kind = 'blog' AND c.metadata->>'slug' = b.slug
  );
