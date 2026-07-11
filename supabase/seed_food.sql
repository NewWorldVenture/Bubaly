-- ============================================================
-- FamilyOS :: seed_food.sql — demo data for the Food & Nutrition hub
--
-- Fills the food-domain tables the hub (/dashboard/food) and Dining Out
-- (/dashboard/dining) read but seed_home.sql doesn't:
--   • family_recipes — 50/family = 250   (Recipes + Family Favorites cards)
--   • pantry_items   — 30/family = 150   (Pantry Inventory card)
--   • dining_out     — 24/family = 120   (Dining Out card + page; restaurants + visits)
--   TOTAL = 520 rows across 3 tables for the 5 demo families.
-- (Meal Planner / Grocery / Nutrition-score cards come from seed.sql + seed_home.sql.)
--
-- REQUIRES seed.sql first (5 demo families). dining_out needs migration
-- 0104_dining_out.sql applied. For a fully populated hub also run seed_home.sql.
--   npm run seed:food
--   = psql "$DATABASE_URL" -f supabase/seed.sql -f supabase/seed_home.sql -f supabase/seed_food.sql
--   (or paste into the Supabase SQL Editor in that order)
--
-- Covers: every recipe category + difficulty; favorites & non-favorites; ratings
-- (incl. null); pantry items expiring soon/future/past/null + low-stock & staples
-- across all storage locations; dining restaurants (rated, priced, favorited) and
-- logged visits (spend + item counts + dates). Long + short text. Null optionals.
--
-- SAFETY: idempotent + pooler-safe; scoped to the 5 demo family ids only (which
-- exist solely for seeding) — clears those families' rows in these tables then
-- re-inserts. Never touches real/production families.
-- ============================================================

delete from public.family_recipes where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');
delete from public.pantry_items   where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');
delete from public.dining_out     where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── family_recipes (50/family = 250) ──
insert into public.family_recipes
  (family_id, name, description, category, cuisine, servings, prep_time_mins, cook_time_mins,
   difficulty, ingredients, instructions, tags, allergy_flags, is_favorite, is_public, rating,
   times_made, photo_url, notes)
select f.id,
       (array['Tuscan Chicken Pasta','Healthy Beef Tacos','Creamy Avocado Pasta','One-Pan Lemon Chicken',
              'Baked Salmon with Asparagus','Vegetable Stir Fry','Banana Oatmeal Pancakes',
              'Chocolate Protein Smoothie','Sheet Pan Chicken Fajitas','Quinoa Power Bowl',
              'Spaghetti Bolognese','Homemade Margherita Pizza','Thai Peanut Chicken Bowl',
              'Greek Yogurt Parfait'])[1+(n%14)] || ' #' || n,
       case when n % 6 = 0 then null
            else 'A family-friendly recipe with balanced nutrition and simple steps.' end,
       (array['dinner','lunch','breakfast','snack','dessert','side','appetizer','drink','other','dinner'])[1+(n%10)],
       (array['Italian','Mexican','American','Mediterranean','Asian','Thai','Greek',null])[1+(n%8)],
       2 + (n % 5),
       5 + (n % 25),
       10 + (n % 40),
       (array['easy','medium','hard'])[1+(n%3)],
       '[{"name":"olive oil","qty":"2 tbsp"},{"name":"garlic","qty":"2 cloves"},{"name":"chicken","qty":"1 lb"}]'::jsonb,
       '[{"step":1,"text":"Prep ingredients."},{"step":2,"text":"Cook until done."},{"step":3,"text":"Serve and enjoy."}]'::jsonb,
       case when n % 3 = 0 then array['quick','healthy']::text[] else '{}'::text[] end,
       case when n % 7 = 0 then array['nuts']::text[] else '{}'::text[] end,
       (n % 4 = 0),                                       -- ~25% favorites
       false,
       case when n % 5 = 0 then null else round((3.5 + ((n % 15) / 10.0))::numeric, 1) end,  -- 3.5–5.0, some null
       n % 12,
       'https://picsum.photos/seed/recipe' || substr(md5(f.id::text || n::text), 1, 6) || '/400/300',
       case when n % 9 = 0 then 'Kids loved this one — make it again soon!' else null end
from public.families f
cross join generate_series(1,50) as n
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── pantry_items (30/family = 150) ──
insert into public.pantry_items
  (family_id, name, category, location, quantity, unit, low_threshold, expires_at, is_staple, notes)
select f.id,
       (array['Quinoa','Brown Rice','Oats','Olive Oil','Peanut Butter','Canned Beans','Almonds',
              'Protein Powder','Honey','Pasta','Flour','Sugar','Milk','Eggs','Greek Yogurt',
              'Cheddar Cheese','Mixed Vegetables','Blueberries','Whole Wheat Bread','Hummus'])[1+(n%20)],
       (array['Grains','Grains','Grains','Oils','Condiments','Canned Goods','Nuts','Supplements',
              'Condiments','Grains','Baking','Baking','Dairy','Dairy','Dairy','Dairy','Frozen','Frozen','Bakery','Other'])[1+(n%20)],
       (enum_range(null::public.pantry_location))[1 + (n % array_length(enum_range(null::public.pantry_location),1))]::public.pantry_location,
       (array[1,2,3,0.5,1.5,2,1,3])[1+(n%8)],
       (array['cups','lb','bag','bottle','jar','cans','tub','loaf'])[1+(n%8)],
       (array[1,1,2,1,0,1,2,1])[1+(n%8)],
       case (n % 4)
         when 0 then null                              -- no expiry
         when 1 then (current_date + (5 + n % 20))::date  -- expiring soon / future
         when 2 then (current_date - (n % 30))::date      -- expired
         else (current_date + 180)::date
       end,
       (n % 5 = 0),                                     -- staples
       case when n % 8 = 0 then 'Running low — add to grocery list.' else null end
from public.families f
cross join generate_series(1,30) as n
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ── dining_out (24/family = 120: 14 saved restaurants + 10 logged visits) ──
insert into public.dining_out
  (family_id, name, kind, cuisine, category, price_level, rating, address, distance_km,
   amount_cents, item_count, is_favorite, visited_at, notes)
select f.id,
       (array['Green Leaf Café','Sushi House','The Grilled Plate','Tony''s Pizzeria','Cafe Delights',
              'Bella Italia','Spice Route','Harvest Table','The Noodle Bar','Coastal Catch',
              'Garden Bistro','Maple & Oak','Fresh Bowl Co.','Urban Tandoor'])[1+(n%14)],
       case when n <= 14 then 'restaurant' else 'visit' end,
       (array['Healthy','Japanese','American','Italian','Cafe','Italian','Indian','Farm-to-table','Asian','Seafood','Vegetarian','Steakhouse','Healthy','Indian'])[1+(n%14)],
       (array['Salads','Sushi','Grill','Pizza','Bakery','Pasta','Curry','Seasonal','Noodles','Fish','Veg','Steak','Bowls','Tandoor'])[1+(n%14)],
       1 + (n % 4),
       round((3.8 + ((n % 12) / 10.0))::numeric, 1),
       (100 + n) || ' Main St',
       round((0.3 + (n % 50) / 10.0)::numeric, 1),
       case when n > 14 then (1500 + (n * 137) % 6000) else null end,   -- visit spend
       case when n > 14 then 1 + (n % 5) else null end,                 -- items on a visit
       (n % 5 = 0),
       case when n > 14 then (now() - ((n * 3) || ' days')::interval) else null end,
       case when n % 7 = 0 then 'Great healthy options the whole family enjoyed.' else null end
from public.families f
cross join generate_series(1,24) as n
where f.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');

-- ============================================================
-- Done. 520 rows across family_recipes / pantry_items / dining_out for 5 demo
-- families. Re-runnable. Verify (optional):
--   select 'recipes' t, count(*) from public.family_recipes where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555')
--   union all select 'pantry', count(*) from public.pantry_items where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555')
--   union all select 'dining', count(*) from public.dining_out where family_id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555');
-- ============================================================
