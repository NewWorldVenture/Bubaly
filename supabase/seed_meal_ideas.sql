-- ============================================================================
-- FamilyOS · SEED — Meal ideas catalog (500 records).
-- The curated, family-agnostic dinner library the first-run briefing (T2) draws
-- its "3 dinner ideas" from. Real dish × cuisine × effort combinations so the
-- picker has variety at volume. Idempotent: clears the seeded catalog first
-- (tags @> '{seed}'), then reinserts. Reference data — not family-scoped.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0139 applied.)
-- ============================================================================
do $$
declare
  n int := 500;
  dishes text[] := array[
    'Sheet-pan Chicken & Veg','Beef Tacos','Veggie Stir-fry','Spaghetti Bolognese','Chicken Curry',
    'Margherita Pizza','Salmon & Rice Bowl','Turkey Chili','Pad Thai','Butter Chicken',
    'Fish Tacos','Caesar Chicken Salad','BBQ Pulled Pork','Shrimp Scampi','Beef Stir-fry',
    'Chicken Fajitas','Mushroom Risotto','Baked Ziti','Teriyaki Salmon','Greek Bowls',
    'Pesto Pasta','Black Bean Burritos','Honey-Garlic Chicken','Ramen Night','Lasagna',
    'Beef Bourguignon','Roast Chicken Dinner','Homemade Pizza Night','Enchiladas','Coconut Curry',
    'Meatball Subs','Sausage & Peppers','Chicken Parmesan','Tuna Poke Bowls','Falafel Wraps'];
  cuisines text[] := array['Comfort','Mexican','Asian','Italian','Indian','Mediterranean','American','Thai','Japanese','French'];
  efforts text[] := array['quick','standard','involved'];
  descs text[] := array[
    'Weeknight-friendly and kid-approved.','One pan, minimal cleanup.','Batch-cook and use leftovers for lunch.',
    'A little more love for a slower evening.','Freezer-friendly — make a double batch.','Ready in under 30 minutes.'];
begin
  if to_regclass('public.meal_ideas') is null then
    raise notice 'meal_ideas not present — apply migration 0139 first. Skipping.';
    return;
  end if;

  delete from public.meal_ideas where tags @> array['seed'];

  insert into public.meal_ideas (title, cuisine, effort, prep_minutes, tags, description, is_active)
  select
    dishes[1 + (g.i % array_length(dishes,1))] || ' #' || g.i,
    cuisines[1 + (g.i % array_length(cuisines,1))],
    eff,
    case eff when 'quick' then 15 + (g.i % 16) when 'standard' then 30 + (g.i % 21) else 60 + (g.i % 61) end,
    array['seed', cuisines[1 + (g.i % array_length(cuisines,1))]],
    descs[1 + (g.i % array_length(descs,1))],
    true
  from generate_series(1, n) g(i)
  cross join lateral (select efforts[1 + (g.i % 3)] as eff) e;

  raise notice 'Meal ideas catalog seeded 500 rows';
end $$;

-- Verify:
--   select count(*) from meal_ideas where tags @> array['seed'];   -- 500
--   select effort, count(*) from meal_ideas group by effort;
