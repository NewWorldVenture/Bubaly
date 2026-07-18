-- ============================================================================
-- Migration 0230: Per-post AEO (auto) + public read for SEO pages
--
--   (1) PER-POST AEO. Every published blog post gets its own AEO questions
--       (source_path = /blog/<slug>), so each article is a citable answer in the
--       Knowledge Center and its own FAQPage. Derived in-DB from the post's
--       title + excerpt so it always matches the live post. Idempotent (tagged
--       metadata->>'seed' = 'blog_aeo_v1'). The admin publish action generates
--       the SAME questions for NEW posts at publish time (lib/marketing/
--       aeo-generate.ts), so the loop is automatic going forward.
--
--   (2) SEO PAGES PUBLIC READ. marketing_seo_pages becomes readable (active rows
--       only) so public routes can drive their <title>/description from the
--       admin SEO store (the single source), with a code fallback.
-- Additive + idempotent. Requires 0013 + 0228 + 0229.
-- ============================================================================

-- (1) Per-post AEO questions --------------------------------------------------
DELETE FROM public.marketing_aeo_questions WHERE metadata->>'seed' = 'blog_aeo_v1';

INSERT INTO public.marketing_aeo_questions
  (question, answer, entity, source_path, pattern, status, clarity_score, last_reviewed, metadata)
SELECT
  'How does Bubaly help with ' || lower(p.title) || '?',
  p.excerpt || ' Bubaly — the AI Family Operating System — turns this into shared, automatic routines your whole family can see. Read the full guide at /blog/' || p.slug || '.',
  'Bubaly',
  '/blog/' || p.slug,
  'faq',
  'published',
  88,
  now(),
  jsonb_build_object('seed','blog_aeo_v1','slug',p.slug,'category',p.category,'article',true)
FROM public.blog_posts p
WHERE p.published AND p.slug NOT LIKE 'seed-blog_posts-%'
UNION ALL
SELECT
  p.title || ' — where should a family start?',
  'Start small and let the system do the remembering. ' || p.excerpt || ' Bubaly — the AI Family Operating System — keeps the whole family in sync. Full guide: /blog/' || p.slug || '.',
  'Bubaly',
  '/blog/' || p.slug,
  'how_to',
  'published',
  86,
  now(),
  jsonb_build_object('seed','blog_aeo_v1','slug',p.slug,'category',p.category,'article',true)
FROM public.blog_posts p
WHERE p.published AND p.slug NOT LIKE 'seed-blog_posts-%';

-- (2) Public read for active SEO pages ---------------------------------------
DROP POLICY IF EXISTS marketing_seo_pages_public_read ON public.marketing_seo_pages;
CREATE POLICY marketing_seo_pages_public_read ON public.marketing_seo_pages
  FOR SELECT TO anon, authenticated
  USING (status = 'active');

GRANT SELECT ON public.marketing_seo_pages TO anon, authenticated;
