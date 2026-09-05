-- ============================================================
-- Bubaly :: seed_weekend.sql — high-volume Weekend Planner demo data
--
-- Seeds >= 500 rows into EACH weekend-planner table for the 5 demo families
-- from seed.sql (run seed.sql FIRST — it creates the families + members):
--   weekend_events   600  (120 / family)
--   weekend_plans    500  (100 / family, one per event)
--   weekend_searches 500  (100 / family)
--   weekend_feeds    500  (100 / family)
--
-- IDEMPOTENT + POOLER-SAFE (no temp tables / BEGIN..COMMIT). Clears prior seed
-- rows for the 5 demo family ids, then re-inserts — safe to run repeatedly and
-- only ever touches those 5 demo families. Supabase SQL Editor friendly.
-- Tables: weekend_events / weekend_plans / weekend_searches / weekend_feeds
-- (migrations 0071_weekend_planner.sql, 0072_weekend_feeds.sql).
-- ============================================================

-- ── Clear prior seed rows (plans cascade from events, but explicit is safe) ──
DELETE FROM public.weekend_plans    WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.weekend_events   WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.weekend_searches WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.weekend_feeds    WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- ── weekend_events: 120 / family = 600 ──────────────────────
INSERT INTO public.weekend_events
  (family_id, source, external_id, title, category, description, venue_name, address, city, region, postal_code,
   latitude, longitude, starts_at, ends_at, url, image_url, price_min_cents, price_max_cents, currency,
   distance_miles, is_family_friendly, search_zip, search_radius, discovered_at)
SELECT
  fam.id,
  (ARRAY['ticketmaster','seatgeek','feed:City Events','feed:School District','rss'])[1 + (g % 5)],
  'seed-' || replace(fam.id::text, '-', '') || '-' || g,
  (ARRAY['Live Music Night','Farmers Market','Kids Science Fair','Community 5K Run','Art Walk',
         'Food Truck Festival','Family Movie in the Park','Little League Game','Museum Free Day','Jazz in the Garden'])[1 + (g % 10)]
    || ' #' || g,
  (ARRAY['music','sports','arts','family','community','food','outdoors'])[1 + (g % 7)],
  'Seeded demo event for load-testing the Weekend Planner.',
  (ARRAY['Civic Center','Downtown Park','Riverside Amphitheater','Community Hall','Sports Complex'])[1 + (g % 5)],
  (100 + g) || ' Main St',
  (ARRAY['Austin','Denver','Seattle','Chicago','Portland'])[1 + (g % 5)],
  (ARRAY['TX','CO','WA','IL','OR'])[1 + (g % 5)],
  lpad(((73000 + g) % 100000)::text, 5, '0'),
  30.0 + (g % 100) * 0.05,
  -97.0 - (g % 100) * 0.05,
  now() + ((g % 14) || ' days')::interval + ((10 + (g % 10)) || ' hours')::interval,
  now() + ((g % 14) || ' days')::interval + ((12 + (g % 10)) || ' hours')::interval,
  'https://example.com/events/' || replace(fam.id::text, '-', '') || '/' || g,
  NULL,
  CASE WHEN g % 3 = 0 THEN 0 ELSE 1500 + (g % 40) * 250 END,
  CASE WHEN g % 3 = 0 THEN 0 ELSE 4000 + (g % 40) * 500 END,
  'USD',
  ((g % 25))::numeric(6,1),
  (g % 4 = 0),
  lpad(((73000 + g) % 100000)::text, 5, '0'),
  (ARRAY[10,25,50])[1 + (g % 3)],
  now() - ((g % 30) || ' days')::interval
FROM (VALUES
  ('11111111-1111-1111-1111-111111111111'::uuid),
  ('22222222-2222-2222-2222-222222222222'::uuid),
  ('33333333-3333-3333-3333-333333333333'::uuid),
  ('44444444-4444-4444-4444-444444444444'::uuid),
  ('55555555-5555-5555-5555-555555555555'::uuid)
) AS fam(id), generate_series(1, 120) AS g;

-- ── weekend_plans: one per event for g<=100 = 100 / family = 500 ──
INSERT INTO public.weekend_plans (family_id, event_id, status, member_ids, notes)
SELECT
  e.family_id,
  e.id,
  (ARRAY['interested','going','maybe','passed'])[1 + (abs(hashtext(e.id::text)) % 4)]::weekend_plan_status,
  COALESCE(
    (SELECT array_agg(m.id) FROM (
        SELECT fm.id FROM public.family_members fm WHERE fm.family_id = e.family_id ORDER BY random() LIMIT 2
     ) m),
    '{}'::uuid[]),
  'Seeded weekend plan'
FROM public.weekend_events e
WHERE e.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid)
  AND e.external_id LIKE 'seed-%'
  AND split_part(e.external_id, '-', 3)::int <= 100;

-- ── weekend_searches: 100 / family = 500 ────────────────────
INSERT INTO public.weekend_searches (family_id, zip, radius_miles, days, result_count, last_run_at)
SELECT
  fam.id,
  lpad(((73000 + g) % 100000)::text, 5, '0'),
  (ARRAY[10,25,50])[1 + (g % 3)],
  1 + (g % 14),
  (g % 60),
  now() - ((g % 45) || ' days')::interval
FROM (VALUES
  ('11111111-1111-1111-1111-111111111111'::uuid),
  ('22222222-2222-2222-2222-222222222222'::uuid),
  ('33333333-3333-3333-3333-333333333333'::uuid),
  ('44444444-4444-4444-4444-444444444444'::uuid),
  ('55555555-5555-5555-5555-555555555555'::uuid)
) AS fam(id), generate_series(1, 100) AS g;

-- ── weekend_feeds: 100 / family = 500 (UNIQUE family_id,url) ──
INSERT INTO public.weekend_feeds (family_id, label, url, kind, is_active, last_count, last_status, last_fetched_at)
SELECT
  fam.id,
  (ARRAY['City Events','School District','Public Library','Parks & Rec','Little League'])[1 + (g % 5)] || ' Feed ' || g,
  'https://feeds.example.com/' || replace(fam.id::text, '-', '') || '/' || g
    || CASE WHEN g % 2 = 0 THEN '.ics' ELSE '.rss' END,
  (CASE WHEN g % 2 = 0 THEN 'ics' ELSE 'rss' END)::weekend_feed_kind,
  (g % 5 <> 0),
  (g % 30),
  'ok',
  now() - ((g % 20) || ' days')::interval
FROM (VALUES
  ('11111111-1111-1111-1111-111111111111'::uuid),
  ('22222222-2222-2222-2222-222222222222'::uuid),
  ('33333333-3333-3333-3333-333333333333'::uuid),
  ('44444444-4444-4444-4444-444444444444'::uuid),
  ('55555555-5555-5555-5555-555555555555'::uuid)
) AS fam(id), generate_series(1, 100) AS g;

-- ── Verify (optional) ───────────────────────────────────────
-- SELECT 'weekend_events' t, count(*) FROM public.weekend_events
--   WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid)
-- UNION ALL SELECT 'weekend_plans', count(*) FROM public.weekend_plans WHERE family_id IN (...)
-- UNION ALL SELECT 'weekend_searches', count(*) FROM public.weekend_searches WHERE family_id IN (...)
-- UNION ALL SELECT 'weekend_feeds', count(*) FROM public.weekend_feeds WHERE family_id IN (...);
