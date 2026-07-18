-- 0233 :: Remove debug-seeded junk from the SEO Page Registry
-- ----------------------------------------------------------------------------
-- The SEO Page Registry (/admin/marketing/seo → public.marketing_seo_pages)
-- drives the <title>/meta description of PUBLIC ROUTES: lib/marketing/seo.ts
-- `getSeoPage(path)` looks a row up by its EXACT route path (e.g. '/pricing')
-- where status='active'. A "Debug data seeding" tool inserted ~100+ rows whose
-- `path` is a label like 'Seed data 1' (and 'Seed data 1 <uuid>') — these match
-- no route, are never queried by getSeoPage(), and drive nothing. They are inert
-- noise that only clutters the admin registry.
--
-- Every REAL registry row is a route and therefore begins with '/'. This deletes
-- the junk (both the 'Seed data%' rows and, defensively, any non-route path that
-- could never resolve). Idempotent — safe to re-run; a clean DB deletes 0 rows.
-- Real rows ('/pricing', '/security', …) are untouched.

DELETE FROM public.marketing_seo_pages
 WHERE path LIKE 'Seed data%'
    OR path NOT LIKE '/%';
