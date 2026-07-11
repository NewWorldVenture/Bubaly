-- ============================================================================
-- FamilyOS · SEED — Meal votes (500 + 2 options each).
-- Fills meal_votes (+ meal_vote_options) at volume so the FOI **communication**
-- dimension (open decisions) and /dashboard/voting render at scale. 500 votes
-- with a status/meal-type spread, each with two options. Idempotent via title
-- like '%[seed-mv]%'; resolves the family by email. (Needs the meals schema.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_user   uuid;
  n int := 500;
  types    text[] := array['breakfast','lunch','dinner','snack'];
  statuses text[] := array['open','open','open','closed'];
  dishes   text[] := array['Tacos','Pasta night','Stir-fry','Pizza','Curry','Burgers','Salad bar','Soup & bread','Breakfast-for-dinner','Grill night'];
begin
  if to_regclass('public.meal_votes') is null then
    raise notice 'meal_votes not present — apply the meals schema first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select fm.user_id into v_user from public.family_members fm
  where fm.family_id = v_family and fm.user_id is not null limit 1;

  -- Options first (FK), then votes: delete children before parents.
  delete from public.meal_vote_options o
    using public.meal_votes v
    where o.vote_id = v.id and v.family_id = v_family and v.title like '%[seed-mv]%';
  delete from public.meal_votes where family_id = v_family and title like '%[seed-mv]%';

  -- 500 votes.
  insert into public.meal_votes (family_id, created_by, title, meal_type, status, meal_date, allow_maybe, created_at)
  select
    v_family, v_user,
    'What''s for ' || types[1+(g.i % 4)] || '? #' || g.i || ' [seed-mv]',
    types[1+(g.i % 4)],
    statuses[1+(g.i % 4)],
    (current_date + (g.i % 21)),
    (g.i % 2 = 0),
    now() - ((g.i % 120) || ' days')::interval
  from generate_series(1, n) g(i);

  -- Two options per seeded vote (distinct dishes).
  insert into public.meal_vote_options (vote_id, family_id, label)
  select v.id, v_family, d.label
  from public.meal_votes v
  cross join lateral (
    select dishes[1 + (abs(hashtext(v.id::text))     % 10)] as label
    union all
    select dishes[1 + ((abs(hashtext(v.id::text)) + 3) % 10)]
  ) d
  where v.family_id = v_family and v.title like '%[seed-mv]%';

  raise notice 'Meal votes seeded 500 (+ options) for family %', v_family;
end $$;

-- Verify:
--   select count(*) from meal_votes where title like '%[seed-mv]%';                     -- 500
--   select count(*) from meal_vote_options o join meal_votes v on v.id=o.vote_id where v.title like '%[seed-mv]%';  -- ~1000
--   select status, count(*) from meal_votes where title like '%[seed-mv]%' group by status;
