-- ============================================================================
-- FamilyOS :: seed_marketplace_platform.sql — high-volume AI-first marketplace demo
--
-- Seeds the full marketplace platform (0120 board + 0138 platform tables) for the
-- 5 demo families from seed.sql, FK-parented and GRAPHICS-rich (every listing +
-- collection + profile has an image URL). Primary scrollable list at 500:
--   marketplace_listings ................ 500  (5 families x 100), each with a photo
-- Plus:
--   marketplace_listing_media ........... 1500 (3 images per listing)
--   marketplace_listing_pricing ......... rent/buy price rows
--   marketplace_profiles ................ one per member (with avatars)
--   marketplace_creator_stores/_products  storefronts
--   marketplace_collections/_items ...... Pinterest-style boards (with covers)
--   marketplace_verifications ........... email/phone verified per member
--   marketplace_trust_scores ............ one per member (score + badges)
--   marketplace_requests/_request_matches wanted posts + AI matches
--   marketplace_orders/_payments ........ transactions in mixed states
--   marketplace_reviews/_ratings ........ two-sided ratings
--   marketplace_offers .................. interest/offers on listings
--
-- HOW TO RUN (needs DB access):
--   psql "$DATABASE_URL" -f supabase/seed.sql -f supabase/seed_marketplace_platform.sql
--
-- IDEMPOTENT + POOLER-SAFE: no temp tables / BEGIN-COMMIT. Clears the marketplace
-- parents for the 5 demo families (children cascade) then re-inserts. created_by
-- is left NULL (demo data isn't owned by a specific auth user). Image URLs use
-- picsum.photos seeded by a stable hash so they render deterministically.
-- ============================================================================

-- ── Clear prior marketplace seed for the 5 demo families (children cascade) ──
DELETE FROM public.marketplace_listings      WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.marketplace_requests      WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.marketplace_orders        WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.marketplace_collections   WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.marketplace_creator_stores WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.marketplace_reviews       WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.marketplace_trust_scores  WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.marketplace_verifications WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.marketplace_profiles      WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);
DELETE FROM public.marketplace_offers        WHERE family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- ============================================================================
-- IDENTITY: profiles, verifications, trust scores, creator stores
-- ============================================================================

-- One marketplace profile per family member, with an avatar graphic.
INSERT INTO public.marketplace_profiles (family_id, member_id, display_name, bio, avatar_url, banner_url, location, is_creator)
SELECT m.family_id, m.id, m.display_name,
  'Friendly neighbor sharing and swapping on Bubaly Marketplace.',
  'https://picsum.photos/seed/' || md5('av' || m.id::text) || '/200/200',
  'https://picsum.photos/seed/' || md5('bn' || m.id::text) || '/1200/300',
  (ARRAY['Downtown','Westside','Northgate','Harbor District','Old Town'])[1 + (abs(hashtext(m.id::text)) % 5)],
  (abs(hashtext(m.id::text)) % 3 = 0)
FROM public.family_members m
WHERE m.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Email + phone verified for every member (UNIQUE family+member+kind).
INSERT INTO public.marketplace_verifications (family_id, member_id, kind, status, verified_at)
SELECT m.family_id, m.id, k.kind, 'verified', now() - ((abs(hashtext(m.id::text)) % 60) || ' days')::interval
FROM public.family_members m, (VALUES ('email'),('phone')) k(kind)
WHERE m.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- A trust score per member with badges (UNIQUE family+member).
INSERT INTO public.marketplace_trust_scores (family_id, member_id, score, completed_transactions, average_rating, response_minutes, disputes, cancellations, badges)
SELECT m.family_id, m.id,
  55 + (abs(hashtext(m.id::text)) % 45),
  (abs(hashtext('tx' || m.id::text)) % 40),
  (40 + (abs(hashtext('rt' || m.id::text)) % 10))::numeric / 10,
  10 + (abs(hashtext('rp' || m.id::text)) % 120),
  (abs(hashtext('dp' || m.id::text)) % 3),
  (abs(hashtext('cx' || m.id::text)) % 2),
  CASE (abs(hashtext(m.id::text)) % 4)
    WHEN 0 THEN ARRAY['verified','repeat_seller']
    WHEN 1 THEN ARRAY['verified','fast_responder']
    WHEN 2 THEN ARRAY['verified','top_rated','trusted']
    ELSE ARRAY['verified'] END
FROM public.family_members m
WHERE m.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- One creator storefront per family (UNIQUE slug), with banner + avatar.
INSERT INTO public.marketplace_creator_stores (family_id, member_id, slug, name, tagline, bio, avatar_url, banner_url, policies, is_active, follower_count)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id = f.id ORDER BY random() LIMIT 1),
  'store-' || substr(md5(f.id::text), 1, 10),
  'The ' || (ARRAY['Corner','Harbor','Maple','Sunset','Cedar'])[1 + (abs(hashtext(f.id::text)) % 5)] || ' Shop',
  'Handmade, pre-loved, and rentable finds for families.',
  'A neighborhood storefront on Bubaly.',
  'https://picsum.photos/seed/' || md5('store' || f.id::text) || '/200/200',
  'https://picsum.photos/seed/' || md5('storebn' || f.id::text) || '/1200/300',
  'Pickup or local delivery. Returns within 3 days.',
  true,
  (abs(hashtext(f.id::text)) % 500)
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id);

-- ============================================================================
-- LISTINGS — 500 (5 families x 100), each with a cover photo + rich attributes
-- ============================================================================
INSERT INTO public.marketplace_listings
  (family_id, member_id, title, description, kind, category, condition, price_cents, rent_period, photo_url, location, status, visibility, modes, brand, color, size, currency, latitude, longitude, tags, allow_offers)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id = f.id ORDER BY random() LIMIT 1),
  (ARRAY['Kids Balance Bike','Formal Dress','Laptop','3-Seat Sofa','Book Bundle','Wooden Toy Set','Cordless Drill','Baby Stroller','Board Game','Camping Tent'])[1 + (n % 10)] || ' #' || n,
  'Gently used and ready for a new home. Auto-seeded demo listing with photos.',
  (ARRAY['sell','sell','rent','borrow','free'])[1 + (n % 5)],
  (ARRAY['sports','clothing','electronics','furniture','books','toys','tools','baby','games','other'])[1 + (n % 10)],
  (ARRAY['new','like_new','good','fair','worn'])[1 + (n % 5)],
  (500 + (n % 40) * 750),
  CASE WHEN (n % 5) = 2 THEN 'day' ELSE NULL END,
  'https://picsum.photos/seed/' || md5('cover' || f.id::text || n::text) || '/600/450',
  (ARRAY['Downtown','Westside','Northgate','Harbor District','Old Town'])[1 + (n % 5)],
  (ARRAY['available','available','available','pending','claimed'])[1 + (n % 5)],
  'public',
  CASE (n % 5)
    WHEN 0 THEN ARRAY['buy','make_offer'] WHEN 1 THEN ARRAY['buy','make_offer']
    WHEN 2 THEN ARRAY['rent'] WHEN 3 THEN ARRAY['borrow'] ELSE ARRAY['donate'] END,
  (ARRAY['Nike','Zara','Apple','Ikea','Lego','Graco','Sony','Adidas','Bosch','Generic'])[1 + (n % 10)],
  (ARRAY['black','blue','red','white','green','gray'])[1 + (n % 6)],
  (ARRAY['S','M','L','XL','One Size'])[1 + (n % 5)],
  'USD',
  (37.5 + (n % 50) * 0.01)::double precision,
  (-122.3 + (n % 50) * 0.01)::double precision,
  ARRAY[(ARRAY['sports','clothing','electronics','furniture','books'])[1 + (n % 5)], (ARRAY['black','blue','red'])[1 + (n % 3)], 'local'],
  (n % 3 <> 0)
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,100) n;

-- 3 gallery images per listing (1500), the first is the cover.
INSERT INTO public.marketplace_listing_media (family_id, listing_id, url, alt_text, is_cover, sort_order)
SELECT l.family_id, l.id,
  'https://picsum.photos/seed/' || md5('media' || l.id::text || g::text) || '/600/450',
  l.title || ' — photo ' || g, (g = 1), g
FROM public.marketplace_listings l, generate_series(1,3) g
WHERE l.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- A pricing row per listing for its primary mode (UNIQUE listing+mode+period).
INSERT INTO public.marketplace_listing_pricing (family_id, listing_id, mode, period, amount_cents, currency)
SELECT l.family_id, l.id,
  CASE l.kind WHEN 'sell' THEN 'buy' WHEN 'rent' THEN 'rent' WHEN 'borrow' THEN 'borrow' ELSE 'buy' END,
  CASE l.kind WHEN 'rent' THEN 'day' ELSE NULL END,
  l.price_cents, 'USD'
FROM public.marketplace_listings l
WHERE l.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- ============================================================================
-- COLLECTIONS (Pinterest-style boards with cover graphics) + items
-- ============================================================================
INSERT INTO public.marketplace_collections (family_id, member_id, title, description, kind, cover_url, is_public)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id = f.id ORDER BY random() LIMIT 1),
  (ARRAY['Wedding Guest Dresses','Baby Gear to Borrow','Camping Gear Rentals','Kids Sports Equipment','Local Handmade Gifts'])[g],
  'A curated board of family favorites.',
  (ARRAY['closet','rental','rental','favorites','gift_guide'])[g],
  'https://picsum.photos/seed/' || md5('col' || f.id::text || g::text) || '/600/450',
  true
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,5) g;

-- 5 listings pinned per collection (UNIQUE collection+listing).
INSERT INTO public.marketplace_collection_items (family_id, collection_id, listing_id, sort_order)
SELECT c.family_id, c.id, l.id, l.rn
FROM public.marketplace_collections c
JOIN LATERAL (
  SELECT id, row_number() OVER () AS rn
  FROM public.marketplace_listings ml WHERE ml.family_id = c.family_id ORDER BY random() LIMIT 5
) l ON true
WHERE c.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- ============================================================================
-- OFFERS on listings (interest / claim / offer)
-- ============================================================================
INSERT INTO public.marketplace_offers (family_id, listing_id, member_id, kind, amount_cents, message, status)
SELECT l.family_id, l.id,
  (SELECT id FROM public.family_members m WHERE m.family_id = l.family_id ORDER BY random() LIMIT 1),
  (ARRAY['interest','claim','offer'])[1 + (n % 3)],
  CASE WHEN (n % 3) = 2 THEN (l.price_cents * (80 + (n % 20)) / 100) ELSE NULL END,
  (ARRAY['Is this still available?','I''d love to take it!','Would you accept a lower price?'])[1 + (n % 3)],
  (ARRAY['open','open','accepted','declined'])[1 + (n % 4)]
FROM public.marketplace_listings l, generate_series(1,1) n
WHERE l.status IN ('available','pending')
  AND (abs(hashtext(l.id::text)) % 3 = 0)
  AND l.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- ============================================================================
-- WANTED REQUESTS + AI MATCHES
-- ============================================================================
INSERT INTO public.marketplace_requests
  (family_id, member_id, title, description, item_type, preferred_mode, size, color, brand, condition, needed_on, return_by, location, radius_miles, budget_cents, status)
SELECT f.id,
  (SELECT id FROM public.family_members m WHERE m.family_id = f.id ORDER BY random() LIMIT 1),
  'Looking for ' || (ARRAY['a formal dress','a kids bike','a stroller','a camping tent','a laptop'])[1 + (n % 5)] || ' #' || n,
  'Wanted post — auto-seeded for demo.',
  (ARRAY['clothing','sports','baby','sports','electronics'])[1 + (n % 5)],
  (ARRAY['buy','rent','borrow','any','buy'])[1 + (n % 5)],
  (ARRAY['S','M','L','XL','One Size'])[1 + (n % 5)],
  (ARRAY['black','blue','red','white','green'])[1 + (n % 5)],
  (ARRAY['Nike','Zara','Apple','Graco','Generic'])[1 + (n % 5)],
  (ARRAY['new','like_new','good','fair','worn'])[1 + (n % 5)],
  current_date + (n % 20), current_date + (n % 20) + 5,
  (ARRAY['Downtown','Westside','Northgate','Harbor District','Old Town'])[1 + (n % 5)],
  25, (2000 + (n % 30) * 500),
  (ARRAY['open','open','matched','open','fulfilled'])[1 + (n % 5)]
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,10) n;

-- 3 suggested matches per request (UNIQUE request+listing).
INSERT INTO public.marketplace_request_matches (family_id, request_id, listing_id, score, reason, status)
SELECT r.family_id, r.id, l.id,
  (60 + (abs(hashtext(l.id::text || r.id::text)) % 40))::numeric,
  'Category + keyword match', 'suggested'
FROM public.marketplace_requests r
JOIN LATERAL (SELECT id FROM public.marketplace_listings ml WHERE ml.family_id = r.family_id ORDER BY random() LIMIT 3) l ON true
WHERE r.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- ============================================================================
-- ORDERS + PAYMENTS (mixed states) + REVIEWS + RATINGS
-- ============================================================================
INSERT INTO public.marketplace_orders
  (family_id, listing_id, buyer_member_id, seller_member_id, mode, fulfillment, subtotal_cents, fee_cents, deposit_cents, tax_cents, total_cents, currency, status)
SELECT f.id, l.id, buyer.id, seller.id, 'buy',
  (ARRAY['pickup','shipping'])[1 + (n % 2)],
  l.price_cents, (l.price_cents / 10) + 90, 0, (l.price_cents * 8 / 100),
  l.price_cents + (l.price_cents * 8 / 100) + 90, 'USD',
  (ARRAY['pending','sold','completed','sold','canceled'])[1 + (n % 5)]
FROM (VALUES ('11111111-1111-1111-1111-111111111111'::uuid),('22222222-2222-2222-2222-222222222222'::uuid),('33333333-3333-3333-3333-333333333333'::uuid),('44444444-4444-4444-4444-444444444444'::uuid),('55555555-5555-5555-5555-555555555555'::uuid)) AS f(id),
     generate_series(1,20) n,
     LATERAL (SELECT id, price_cents FROM public.marketplace_listings ml WHERE ml.family_id = f.id AND ml.kind = 'sell' ORDER BY random() LIMIT 1) l,
     LATERAL (SELECT id FROM public.family_members m WHERE m.family_id = f.id ORDER BY random() LIMIT 1) buyer,
     LATERAL (SELECT id FROM public.family_members m WHERE m.family_id = f.id ORDER BY random() LIMIT 1) seller;

-- One payment per order; status derived from the order.
INSERT INTO public.marketplace_payments (family_id, order_id, amount_cents, fee_cents, currency, status)
SELECT o.family_id, o.id, o.total_cents, o.fee_cents, 'USD',
  CASE o.status WHEN 'sold' THEN 'succeeded' WHEN 'completed' THEN 'succeeded' WHEN 'canceled' THEN 'canceled' ELSE 'pending' END
FROM public.marketplace_orders o
WHERE o.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- A two-sided review per settled order (UNIQUE order+reviewer+role).
INSERT INTO public.marketplace_reviews (family_id, order_id, role, rating, body)
SELECT o.family_id, o.id, 'buyer', 3 + (abs(hashtext(o.id::text)) % 3),
  (ARRAY['Great transaction, would buy again!','Item as described, smooth pickup.','Friendly and quick to respond.'])[1 + (abs(hashtext(o.id::text)) % 3)]
FROM public.marketplace_orders o
WHERE o.status IN ('sold','completed')
  AND o.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- Per-dimension ratings for each review (UNIQUE review+dimension).
INSERT INTO public.marketplace_ratings (family_id, review_id, dimension, score)
SELECT rv.family_id, rv.id, d.dim, 3 + (abs(hashtext(rv.id::text || d.dim)) % 3)
FROM public.marketplace_reviews rv, (VALUES ('communication'),('reliability'),('item_accuracy'),('overall')) d(dim)
WHERE rv.family_id IN ('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,'33333333-3333-3333-3333-333333333333'::uuid,'44444444-4444-4444-4444-444444444444'::uuid,'55555555-5555-5555-5555-555555555555'::uuid);

-- ============================================================================
-- Done! High-volume, graphics-rich marketplace seeded for the 5 demo families.
-- ============================================================================
