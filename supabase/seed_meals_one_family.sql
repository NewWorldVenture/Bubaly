-- ============================================================================
-- seed_meals_one_family.sql — populate the Meals page for ONE family.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES (all scoped to The Kramer Family, 92298eb2-…):
--   0. Re-asserts family-scoped RLS on the meals-domain tables (so the page can
--      READ the rows — same drift fix as migration 0107). Idempotent.
--   1. ~40 meals (with photos) across breakfast/lunch/dinner/snack.
--   2. 504 meal_plans — 18 weeks (10 past → 7 future) × 7 days × 4 meal types,
--      so the grid, "What's for Dinner?", and history all populate. (>= 500 rows)
--   3. ~16 family_recipes with photos, favorites, and last_made_at (powers the
--      Recipes / Favorites tabs and the Recently Cooked strip).
--   4. One Family Vote (3 options + member ballots) for the Family Vote card.
--   5. A grocery list with ~12 items for the Grocery List card / Groceries tab.
--
-- TABLES: meals, meal_plans, family_recipes, meal_votes, meal_vote_options,
--         meal_vote_ballots, grocery_lists, grocery_items.
--
-- IDEMPOTENT: meals tagged in notes '[seed:meals]', recipes tagged tag
--   'seed:recipes', the vote matched by title, grocery list by name — all
--   cleared before re-insert (this family only). Safe to re-run.
--
-- HOW TO RUN: paste into the Supabase SQL editor, Run, then hard-refresh
--   /dashboard/meals.
-- ============================================================================

-- 0) RLS repair --------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['meals','meal_plans','family_recipes','meal_votes','meal_vote_options','meal_vote_ballots','grocery_lists','grocery_items'] loop
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name=t and column_name='family_id') then
      execute format('alter table public.%I enable row level security;', t);
      execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
      execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
      execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
      execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
      execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
    end if;
  end loop;
end $$;

-- 1) – 5) Data ---------------------------------------------------------------
do $$
declare
  v_fam uuid := coalesce((select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1),(select fm.family_id from public.family_members fm where fm.is_active and fm.role not in ('parent','adult') group by fm.family_id order by min(fm.created_at) limit 1),(select id from public.families order by created_at limit 1));  -- reproducible (was a hardcoded prod UUID)
  v_email text := 'newworldventurellc@gmail.com';
  v_uid  uuid;  v_members uuid[];  v_list uuid;
  v_break uuid[] := '{}';  v_lunch uuid[] := '{}';  v_dinner uuid[] := '{}';  v_snack uuid[] := '{}';
  newid uuid;  v_voteid uuid;  o1 uuid; o2 uuid; o3 uuid;
  i int; w int; di int; v_date date; seeded int := 0;  v_mid uuid;  k int;

  img text[] := array[
    'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1551782450-a2132b4ba21d?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1466637574441-749b8f19452f?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&h=400&fit=crop'
  ];
  bnames text[] := array['Greek Yogurt Parfait','Avocado Toast','Smoothie Bowl','Overnight Oats','Pancakes & Berries','Breakfast Burrito','Veggie Omelette','French Toast','Bagel & Lox','Fruit Salad'];
  lnames text[] := array['Turkey & Cheese Wrap','Chicken Caesar Salad','Quesadilla','Caprese Sandwich','Margherita Pizza','Grilled Cheese & Tomato Soup','Ham & Cheese Sandwich','Buddha Bowl','Sushi Bowl','BLT Sandwich'];
  dnames text[] := array['Lemon Garlic Chicken','Spaghetti Bolognese','Beef Stir Fry','Baked Salmon & Veggies','Tacos','BBQ Chicken & Corn','Sunday Roast & Potatoes','Veggie Curry','Shrimp Scampi','Chicken Alfredo','Teriyaki Salmon','Pork Chops & Apples'];
  snames text[] := array['Apple & Peanut Butter','Trail Mix','Banana & Almonds','Yogurt & Berries','Cheese & Grapes','Popcorn','Mixed Fruit','Hummus & Veggies'];
begin
  if not exists (select 1 from public.families where id = v_fam) then raise exception 'Family % not found', v_fam; end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_fam and is_active;

  -- Clean prior seed (plans first for the FK, then meals/recipes/vote/grocery).
  delete from public.meal_plans where family_id = v_fam
    and meal_id in (select id from public.meals where family_id = v_fam and notes like '%[seed:meals]%');
  delete from public.meals where family_id = v_fam and notes like '%[seed:meals]%';
  delete from public.family_recipes where family_id = v_fam and 'seed:recipes' = any(tags);
  delete from public.meal_votes where family_id = v_fam and title = 'Help decide next week''s meals!';

  -- 1) Meals (collect ids per type).
  for i in 1..array_length(bnames,1) loop
    insert into public.meals (family_id,name,meal_type,image_url,ingredients,notes,created_by)
    values (v_fam,bnames[i],'breakfast',img[1+((i-1)%array_length(img,1))],'[]'::jsonb,'[seed:meals]',v_uid) returning id into newid;
    v_break := array_append(v_break,newid);
  end loop;
  for i in 1..array_length(lnames,1) loop
    insert into public.meals (family_id,name,meal_type,image_url,ingredients,notes,created_by)
    values (v_fam,lnames[i],'lunch',img[1+(i%array_length(img,1))],'[]'::jsonb,'[seed:meals]',v_uid) returning id into newid;
    v_lunch := array_append(v_lunch,newid);
  end loop;
  for i in 1..array_length(dnames,1) loop
    insert into public.meals (family_id,name,meal_type,image_url,recipe_url,ingredients,notes,created_by)
    values (v_fam,dnames[i],'dinner',img[1+((i+2)%array_length(img,1))],'https://www.allrecipes.com/','[]'::jsonb,'[seed:meals]',v_uid) returning id into newid;
    v_dinner := array_append(v_dinner,newid);
  end loop;
  for i in 1..array_length(snames,1) loop
    insert into public.meals (family_id,name,meal_type,image_url,ingredients,notes,created_by)
    values (v_fam,snames[i],'snack',img[1+((i+5)%array_length(img,1))],'[]'::jsonb,'[seed:meals]',v_uid) returning id into newid;
    v_snack := array_append(v_snack,newid);
  end loop;

  -- 2) Meal plans: 18 weeks (-10..+7), Monday-based, 4 meals/day = 504 rows.
  for w in -10..7 loop
    for di in 0..6 loop
      v_date := date_trunc('week', current_date)::date + (w*7) + di;
      insert into public.meal_plans (family_id,meal_id,plan_date,meal_type,created_by) values
        (v_fam, v_break [1+((w+di+10) % array_length(v_break,1))],  v_date, 'breakfast', v_uid),
        (v_fam, v_lunch [1+((w+di+3)  % array_length(v_lunch,1))],  v_date, 'lunch',     v_uid),
        (v_fam, v_dinner[1+((w*2+di)  % array_length(v_dinner,1))], v_date, 'dinner',    v_uid),
        (v_fam, v_snack [1+((w+di+1)  % array_length(v_snack,1))],  v_date, 'snack',     v_uid);
      seeded := seeded + 4;
    end loop;
  end loop;

  -- 3) Recipes (photos, favorites, recently cooked).
  insert into public.family_recipes
    (family_id,name,category,cuisine,servings,prep_time_mins,cook_time_mins,difficulty,photo_url,tags,is_favorite,times_made,last_made_at,rating,created_by)
  select v_fam, d.name, d.cat, d.cuisine, 4, d.prep, d.cook, d.diff,
         img[1+((d.ix-1)%array_length(img,1))], array['seed:recipes'], d.fav, d.made,
         now() - (d.daysago || ' days')::interval, d.rating, v_uid
  from (values
    (1,'Lemon Garlic Chicken','dinner','American',15,40,'easy',true, 8, 2, 5),
    (2,'Spaghetti Bolognese','dinner','Italian',15,45,'medium',true,12, 5, 5),
    (3,'Baked Salmon & Veggies','dinner','American',10,25,'easy',true, 6, 9, 4),
    (4,'Chicken Tacos','dinner','Mexican',20,20,'easy',true,15, 1, 5),
    (5,'Beef Stir Fry','dinner','Asian',15,15,'easy',false,9, 3, 4),
    (6,'Chicken Alfredo','dinner','Italian',10,30,'medium',true,7, 12,4),
    (7,'Veggie Curry','dinner','Indian',20,35,'medium',false,4, 18,4),
    (8,'BBQ Pulled Pork','dinner','American',30,240,'hard',false,3, 30,5),
    (9,'Greek Yogurt Parfait','breakfast','Greek',5,0,'easy',true,20, 0, 4),
    (10,'Avocado Toast','breakfast','American',5,5,'easy',false,14,1, 4),
    (11,'Pancakes & Berries','breakfast','American',10,15,'easy',true,11,7, 5),
    (12,'Caesar Salad','lunch','Italian',15,0,'easy',false,8, 4, 4),
    (13,'Margherita Pizza','lunch','Italian',20,15,'medium',true,10,6, 5),
    (14,'Buddha Bowl','lunch','American',20,10,'easy',false,6, 11,4),
    (15,'Grilled Cheese & Tomato Soup','lunch','American',10,15,'easy',true,9,3, 4),
    (16,'Trail Mix','snack','American',5,0,'easy',false,25,2, 3)
  ) as d(ix,name,cat,cuisine,prep,cook,diff,fav,made,daysago,rating);

  -- 4) Family Vote (3 options + member ballots).
  insert into public.meal_votes (family_id,title,status,meal_type,created_by)
  values (v_fam,'Help decide next week''s meals!','open','dinner',v_uid) returning id into v_voteid;
  insert into public.meal_vote_options (vote_id,family_id,label,photo_url)
    values (v_voteid,v_fam,'Teriyaki Salmon',  img[8]) returning id into o1;
  insert into public.meal_vote_options (vote_id,family_id,label,photo_url)
    values (v_voteid,v_fam,'Chicken Alfredo',  img[5]) returning id into o2;
  insert into public.meal_vote_options (vote_id,family_id,label,photo_url)
    values (v_voteid,v_fam,'Veggie Stir Fry',  img[6]) returning id into o3;
  -- One ballot per member, weighted toward option 1.
  if v_members is not null then
    for k in 1..array_length(v_members,1) loop
      v_mid := v_members[k];
      insert into public.meal_vote_ballots (vote_id,option_id,family_id,member_id,choice)
      values (v_voteid, case when k % 3 = 1 then o1 when k % 3 = 2 then o2 else o3 end, v_fam, v_mid, 'yes');
    end loop;
  end if;

  -- 5) Grocery list + items.
  select id into v_list from public.grocery_lists where family_id = v_fam and name = 'Weekly Groceries' limit 1;
  if v_list is null then
    insert into public.grocery_lists (family_id,name,created_by) values (v_fam,'Weekly Groceries',v_uid) returning id into v_list;
  end if;
  delete from public.grocery_items where list_id = v_list;
  insert into public.grocery_items (family_id,list_id,name,quantity,category,is_checked,created_by) values
    (v_fam,v_list,'Chicken Breast','2 lbs','Meat',false,v_uid),
    (v_fam,v_list,'Broccoli','2 heads','Produce',false,v_uid),
    (v_fam,v_list,'Bell Peppers','3','Produce',false,v_uid),
    (v_fam,v_list,'Greek Yogurt','32 oz','Dairy',false,v_uid),
    (v_fam,v_list,'Eggs','1 dozen','Dairy',false,v_uid),
    (v_fam,v_list,'Milk','1 gal','Dairy',true,v_uid),
    (v_fam,v_list,'Bananas','1 bunch','Produce',false,v_uid),
    (v_fam,v_list,'Brown Rice','2 lbs','Pantry',false,v_uid),
    (v_fam,v_list,'Olive Oil','1 bottle','Pantry',true,v_uid),
    (v_fam,v_list,'Spinach','1 bag','Produce',false,v_uid),
    (v_fam,v_list,'Cheddar Cheese','8 oz','Dairy',false,v_uid),
    (v_fam,v_list,'Whole Wheat Bread','1 loaf','Bakery',false,v_uid);

  raise notice 'Seeded % meal_plans + % meals + recipes/vote/grocery for family %.',
    seeded, array_length(v_break,1)+array_length(v_lunch,1)+array_length(v_dinner,1)+array_length(v_snack,1), v_fam;
end $$;

-- Verify ---------------------------------------------------------------------
select
  (select count(*) from public.meal_plans     where family_id=(select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1)) as meal_plans,
  (select count(*) from public.meals          where family_id=(select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1) and notes like '%[seed:meals]%') as meals,
  (select count(*) from public.family_recipes where family_id=(select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1) and 'seed:recipes'=any(tags)) as recipes,
  (select count(*) from public.family_recipes where family_id=(select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1) and is_favorite) as favorites,
  (select count(*) from public.grocery_items gi join public.grocery_lists gl on gl.id=gi.list_id where gl.family_id=(select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1)) as grocery_items;
