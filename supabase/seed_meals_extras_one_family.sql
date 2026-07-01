-- ============================================================================
-- seed_meals_extras_one_family.sql — data for the new Meals sub-pages:
--   Family Favorites (family_favorites) + Nutrition Tracker (nutrition_logs).
-- ----------------------------------------------------------------------------
-- Seeds ~24 favorites and ~150 nutrition log entries (across members, meals,
-- and the last ~14 days incl. today) for ONE family. Requires migration
-- 0115_meals_hub.sql applied first.
--
-- TARGET FAMILY: 92298eb2-1a9e-4bdc-9361-677b6c01b499 (newworldventurellc@gmail.com).
-- IDEMPOTENT: seeded rows tagged notes='[seed]' and removed before re-insert.
-- RUN: npm run db:seed:meals   (or psql -f this file)
-- VERIFY: /dashboard/favorites and /dashboard/nutrition.
-- ============================================================================

do $$
declare
  v_fam uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email text := 'newworldventurellc@gmail.com';
  v_uid uuid; v_members uuid[]; n int; i int; d int;
  kinds text[] := ARRAY['recipe','restaurant','meal','snack','drink','other'];
  fav_names text[] := ARRAY['Grandma''s Lasagna','Taco Tuesday','Homemade Pizza','Chicken Alfredo','Sunday Pancakes','Veggie Stir-Fry','BBQ Ribs','Mac & Cheese','Sushi Night','Green Smoothie','The Corner Bistro','Luigi''s Pizzeria','Fresh Bowl Cafe','Sunrise Diner','Berry Parfait','Banana Bread','Chili','Fish Tacos','Lemonade','Trail Mix','Caesar Salad','Beef Stew','Pad Thai','Apple Pie'];
  meals text[] := ARRAY['breakfast','lunch','dinner','snack'];
  items text[] := ARRAY['Oatmeal with berries','Scrambled eggs','Greek yogurt','Turkey sandwich','Caesar salad','Grilled chicken','Spaghetti','Salmon & rice','Apple','Protein bar','Banana','Veggie wrap','Cheeseburger','Rice & beans','Smoothie','Trail mix','Yogurt parfait','Pasta salad','Chicken soup','Granola'];
begin
  select id into v_uid from auth.users where lower(email)=lower(v_email) limit 1;
  if v_uid is null then raise notice 'Seed skipped: no user'; return; end if;
  if not exists (select 1 from public.families where id=v_fam) then raise notice 'Seed skipped: no family'; return; end if;
  select array_agg(id) into v_members from public.family_members where family_id=v_fam and is_active;
  n := coalesce(array_length(v_members,1),0);
  if n = 0 then raise notice 'Seed skipped: no members'; return; end if;

  delete from public.family_favorites where family_id=v_fam and notes='[seed]';
  delete from public.nutrition_logs where family_id=v_fam and notes='[seed]';

  -- Favorites (24)
  for i in 1..array_length(fav_names,1) loop
    insert into public.family_favorites (family_id, member_id, kind, name, rating, notes, created_by)
    values (v_fam, v_members[1 + (i % n)], kinds[1 + (i % array_length(kinds,1))], fav_names[i],
      3 + (i % 3), '[seed]', v_uid);
  end loop;

  -- Nutrition logs: for each of last 14 days, a few entries per member
  for d in 0..13 loop
    for i in 1..(8 + (d % 4)) loop
      insert into public.nutrition_logs (family_id, member_id, logged_on, meal, item, calories, protein_g, carbs_g, fat_g, water_ml, notes, created_by)
      values (v_fam, v_members[1 + ((i + d) % n)], (now() - (d * interval '1 day'))::date,
        meals[1 + (i % 4)], items[1 + ((i * 3 + d) % array_length(items,1))],
        120 + (i * 37 % 520), round((3 + (i % 30))::numeric,1), round((10 + (i*2 % 60))::numeric,1),
        round((2 + (i % 22))::numeric,1), case when i % 3 = 0 then 250 else 0 end, '[seed]', v_uid);
    end loop;
  end loop;

  raise notice 'Seeded favorites + nutrition logs for family %', v_fam;
end $$;
