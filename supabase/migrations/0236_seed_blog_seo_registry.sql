-- ============================================================================
-- Migration 0236: Register EVERY blog article in the SEO Page Registry
-- The SEO Page Registry (marketing_seo_pages, shown at /admin/marketing/seo)
-- held only the ~19 top-level routes + category tabs — none of the 1,000+ blog
-- articles. This registers a registry row for every published blog post so the
-- whole content library is tracked, auditable, and (via lib/marketing/seo.ts +
-- the article's generateMetadata) can drive each page's <title>/description
-- from the admin console — the single source of truth.
--
-- Each row carries: an SEO title, a bounded meta description, an audit score,
-- index policy, and metadata (category = parent topic, keyword cluster derived
-- from the post's hashtags with the '#' stripped, canonical URL, search intent,
-- schema type). Active rows are public-readable (0230), so the public site can
-- resolve them.
--
-- Idempotent: ON CONFLICT (path) DO UPDATE. Requires 0013 + 0234 (all posts).
-- ============================================================================

INSERT INTO public.marketing_seo_pages (path, title, meta_description, status, score, last_audited_at, metadata)
SELECT
  '/blog/' || b.slug,
  b.title,
  left(regexp_replace(b.excerpt, '\s+', ' ', 'g'), 155),
  'active',
  90,
  now(),
  jsonb_build_object(
    'seed', 'blog_seo_v1',
    'type', 'BlogPosting',
    'category', b.category,
    'parent_topic', b.category,
    'cluster', b.category,
    'search_intent', 'informational',
    'canonical', 'https://www.bubaly.com/blog/' || b.slug,
    'og_type', 'article',
    'keywords', COALESCE((
      SELECT array_agg(lower(regexp_replace(t, '^#', '')))
      FROM unnest(b.tags) AS t
      WHERE regexp_replace(t, '^#', '') <> ''
    ), ARRAY[]::text[]),
    'author', b.author,
    'published_at', b.published_at
  )
FROM public.blog_posts b
WHERE b.published
  AND b.slug NOT LIKE 'seed-blog_posts-%'
ON CONFLICT (path) DO UPDATE SET
  title            = EXCLUDED.title,
  meta_description = EXCLUDED.meta_description,
  status           = EXCLUDED.status,
  score            = EXCLUDED.score,
  last_audited_at  = EXCLUDED.last_audited_at,
  metadata         = EXCLUDED.metadata;
