-- ============================================================================
-- Bubaly · SEED — Dining Out (500 records).
-- Fills dining_out so the upgraded Dining page can be tested at volume:
-- 100 saved restaurants (cuisines, price levels, ratings, favorites) +
-- 400 logged visits over ~2 years (spend + item counts) so the 30-day stat
-- tiles, favorites, and history all light up.
-- Idempotent: clears its own '[seed:dine]' rows (notes tag) first.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0104 applied.)
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  names    text[] := array[
    'Nonna''s Trattoria','Sakura Sushi','The Green Fork','Taco Luna','Bombay Spice',
    'Le Petit Bistro','Golden Wok','Athens Gyro House','Smokehouse 52','Pho Saigon',
    'La Cocina','Ramen Koji','The Garden Table','Brick Oven Pizzeria','Seoul Kitchen',
    'Falafel King','Casa Verde','The Daily Catch','Butter & Thyme','Mama Rosa''s'];
  cuisines text[] := array['Italian','Japanese','Healthy','Mexican','Indian','French','Chinese','Greek','BBQ','Vietnamese'];
begin
  if to_regclass('public.dining_out') is null then
    raise notice 'dining_out not present — apply migration 0104 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select user_id into v_user from public.family_members
  where family_id = v_family and user_id is not null order by created_at limit 1;

  delete from public.dining_out where family_id = v_family and notes = '[seed:dine]';

  -- 100 saved restaurants.
  insert into public.dining_out
    (family_id, name, kind, cuisine, category, price_level, rating, distance_km,
     is_favorite, notes, created_by, created_at)
  select
    v_family,
    names[1 + (g.i % 20)] || case when g.i >= 20 then ' ' || (1 + g.i / 20)::text else '' end,
    'restaurant',
    cuisines[1 + (g.i % 10)],
    case when g.i % 4 = 0 then 'Healthy' else null end,
    1 + (g.i % 4),
    round((3.2 + (g.i % 18) / 10.0)::numeric, 1),
    round((0.4 + (g.i % 120) / 10.0)::numeric, 1),
    (g.i % 5 = 0),
    '[seed:dine]',
    v_user,
    now() - (g.i || ' days')::interval
  from generate_series(0, 99) g(i);

  -- 400 visits across ~2 years.
  insert into public.dining_out
    (family_id, name, kind, amount_cents, item_count, visited_at,
     notes, created_by, created_at)
  select
    v_family,
    names[1 + (g.i % 20)],
    'visit',
    1800 + (g.i * 137) % 14200,
    2 + (g.i % 7),
    now() - ((g.i * 43) % 730 || ' days')::interval - ((g.i % 5) || ' hours')::interval,
    '[seed:dine]',
    v_user,
    now() - (g.i || ' hours')::interval
  from generate_series(0, 399) g(i);

  raise notice 'Dining Out seeded 500 rows (100 restaurants + 400 visits) for family %', v_family;
end $$;

-- Verify:
--   select count(*) from dining_out where notes = '[seed:dine]';                -- 500
--   select kind, count(*) from dining_out group by kind;
--   select count(*) from dining_out where kind='visit' and visited_at > now() - interval '30 days';
