-- ============================================================================
-- FamilyOS · SEED — Meals (meals 500 + family_recipes 500 + meal_plans 500).
-- Fills the meal planner: a library of meals + recipes, and 500 planned days.
-- Idempotent via '[seed:meal]' notes / '[seed:meal]' description markers.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  names text[] := array['Spaghetti Bolognese','Tacos','Grilled Chicken','Veggie Stir Fry','Pancakes',
                        'Caesar Salad','Beef Chili','Salmon & Rice','Margherita Pizza','Chicken Curry',
                        'Turkey Sandwich','Omelette','Pasta Primavera','BBQ Ribs','Fish Tacos'];
  types text[] := array['breakfast','lunch','dinner','snack'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(v_email) = lower(u.email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.meal_plans mp using public.meals m
    where mp.meal_id = m.id and m.family_id = v_family and m.notes = '[seed:meal]';
  delete from public.meals where family_id = v_family and notes = '[seed:meal]';
  delete from public.family_recipes where family_id = v_family and description = '[seed:meal]';

  -- Meals library (500) + one meal_plan per meal (500 planned days).
  with new_meals as (
    insert into public.meals (family_id, name, meal_type, notes)
    select v_family,
      names[1 + (g.i % array_length(names,1))] || ' #' || g.i,
      types[1 + (g.i % array_length(types,1))]::meal_type,
      '[seed:meal]'
    from generate_series(1, n) as g(i)
    returning id, meal_type
  ), numbered as (
    select id, meal_type, row_number() over () as rn from new_meals
  )
  insert into public.meal_plans (family_id, meal_id, plan_date, meal_type)
  select v_family, nm.id, (current_date + (nm.rn::int - 250)), nm.meal_type
  from numbered nm;

  -- Recipe book (500).
  insert into public.family_recipes (family_id, name, description, category, servings, prep_time_mins, cook_time_mins, difficulty, ingredients, instructions)
  select v_family,
    names[1 + (g.i % array_length(names,1))] || ' (recipe #' || g.i || ')',
    '[seed:meal]',
    (array['dinner','lunch','breakfast','dessert'])[1 + (g.i % 4)],
    2 + (g.i % 6),
    5 + (g.i % 30),
    10 + (g.i % 45),
    (array['easy','medium','hard'])[1 + (g.i % 3)],
    '[]'::jsonb, '[]'::jsonb
  from generate_series(1, n) as g(i);

  raise notice 'Meals + recipes + plans seeded % rows each for family %', n, v_family;
end $$;
