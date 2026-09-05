-- ============================================================================
-- seed_watchlist_one_family.sql — Family Watchlist demo data for ONE family (TODO-0408)
-- ----------------------------------------------------------------------------
-- WHAT IT SEEDS (250 rows per table):
--   • watchlist_titles — 250 movies / series / documentaries / kids titles with
--                        year, genres, age rating + min age, runtime, service,
--                        status mix (want / watching / watched / skipped), priority
--   • watchlist_votes  — 250 votes (unique title × member pairs: love / up / down)
--   • watch_sessions   — 250 movie nights, one per day going back, with attendees + ratings
-- TARGET FAMILY: resolved at runtime (v_email's family → first family).
-- IDEMPOTENT: rows carry notes = '[seed:watchlist]' and are deleted before re-insert.
-- HOW TO RUN: npm run db:seed:watchlist   REQUIRES: migration 0241
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_members uuid[];
  m_count   int;
  n         int := 250;
  names     text[] := array[
    'The Lighthouse Keepers','Paper Planes','Summer at Maple Lake','Robot Bakery','The Great Garden Race','Moonlight Detectives',
    'Captain Kite','Treehouse Tales','The Last Snow Fort','Grandma''s Secret Recipe','Skate City','Whale Song',
    'The Backyard Astronauts','Museum After Dark','Puppy School','Mountain Rescue Team','The Secret Library','Ocean Explorers',
    'Junior Chefs','The Kindness Project','Dinosaur Island','Pirate Pancakes','Big City Bikes','The Time Capsule',
    'Wild Weather','Volcano Watch','The Bridge Builders','Night at the Aquarium','Soccer Summer','The Cardboard Kingdom',
    'Family Road Trip','The Missing Mittens','Lantern Festival','Camp Firefly','The Science Fair','Penguin Parade',
    'Tiny House Big Dreams','The Orchestra Kids','Desert Stars','The Puzzle Box','Rainy Day Rescue','Snow Day',
    'Little Lions','The Fixers','Kite Runner Kids','Deep Sea Diary','The Apple Orchard','Marathon Mom',
    'The Chess Club','Space Camp Diaries','Ranch Hands','The Great Bake','Birdwatchers','The Neighborhood',
    'Bridge to Somewhere','Sunday Pancakes','Coral Reef Rangers','The Coding Club','Ballet Shoes','Hometown Heroes'];
  kinds     text[] := array['movie','movie','show','documentary','kids','movie','show','special'];
  services  text[] := array['netflix','disney','prime','hulu','max','apple','peacock','paramount','youtube','library','theater','other'];
  ratings   text[] := array['G','PG','TV-Y','TV-Y7','PG-13','TV-PG','TV-14','TV-G','R','NR'];
  minages   int[]  := array[0,8,0,7,13,8,14,0,17,0];
  genres_a  text[] := array['adventure','comedy','family','animation','drama','documentary','fantasy','sports','mystery','music'];
  statuses  text[] := array['want','want','want','want','want','want','watching','watched','watched','watched','watched','skipped'];
  votes     text[] := array['up','love','up','down','love','up'];
  i         int;
  rid       int;
  tid       uuid;
  tname     text;
  mem       uuid;
begin
  if to_regclass('public.watchlist_titles') is null then
    raise notice 'watchlist_titles not present — apply migration 0241 first. Skipping.';
    return;
  end if;
  select f.id into v_family from public.families f
    join public.family_members fm on fm.family_id = f.id join auth.users u on u.id = fm.user_id
    where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id order by created_at) into v_members from public.family_members where family_id = v_family and is_active;
  m_count := coalesce(array_length(v_members, 1), 0);
  if m_count = 0 then raise exception 'Family % has no active members.', v_family; end if;
  select fm.user_id into v_user from public.family_members fm where fm.family_id = v_family and fm.user_id is not null order by fm.created_at limit 1;

  delete from public.watch_sessions where family_id = v_family and notes = '[seed:watchlist]';
  delete from public.watchlist_titles where family_id = v_family and notes = '[seed:watchlist]';  -- cascades votes

  -- 1) 250 titles ----------------------------------------------------------
  for i in 1..n loop
    rid := 1 + (i % array_length(ratings, 1));
    insert into public.watchlist_titles (family_id, title, kind, year, genres, age_rating, min_age, runtime_min, service, status, priority, added_by, notes, created_by)
    values (v_family,
      names[1 + (i % array_length(names, 1))] || case when i > array_length(names, 1) then ' ' || (i / array_length(names, 1) + 1) else '' end,
      kinds[1 + (i % array_length(kinds, 1))],
      1990 + ((i * 7) % 36),
      array[genres_a[1 + (i % 10)], genres_a[1 + ((i * 3) % 10)]],
      ratings[rid], minages[rid],
      case kinds[1 + (i % array_length(kinds, 1))] when 'show' then 22 + (i % 40) when 'kids' then 20 + (i % 60) else 75 + ((i * 13) % 110) end,
      services[1 + ((i * 5) % array_length(services, 1))],
      statuses[1 + (i % array_length(statuses, 1))],
      1 + (i % 3),
      v_members[1 + (i % m_count)],
      '[seed:watchlist]', v_user);
  end loop;

  create temp table tmp_wl_titles on commit drop as
    select id, title, status, runtime_min, row_number() over (order by created_at, id) as rn, count(*) over () as cnt
    from public.watchlist_titles where family_id = v_family and notes = '[seed:watchlist]';
  create index on tmp_wl_titles (rn);

  -- 2) 250 votes (unique title × member) ------------------------------------
  for i in 1..n loop
    select id into tid from tmp_wl_titles where rn = 1 + ((i - 1) % 250);
    mem := v_members[1 + ((i * 7) % m_count)];
    insert into public.watchlist_votes (family_id, title_id, member_id, vote, created_by)
    values (v_family, tid, mem, votes[1 + (i % array_length(votes, 1))], v_user)
    on conflict (title_id, member_id) do nothing;
  end loop;

  -- 3) 250 movie nights ------------------------------------------------------
  for i in 1..n loop
    select id, title into tid, tname from tmp_wl_titles where rn = 1 + ((i * 11) % 250);
    insert into public.watch_sessions (family_id, title_id, title_name, watched_on, member_ids, rating, minutes, notes, created_by)
    values (v_family, tid, tname, current_date - i,
      case when m_count >= 3 and i % 3 = 0 then v_members[1:3] when m_count >= 2 and i % 2 = 0 then v_members[1:2] else v_members[1:1] end,
      case when i % 5 = 0 then null else 2 + (i % 4) end,
      60 + ((i * 17) % 120), '[seed:watchlist]', v_user);
  end loop;

  raise notice 'Watchlist seeded: % titles, % votes, % sessions for family %', n, n, n, v_family;
end $$;
