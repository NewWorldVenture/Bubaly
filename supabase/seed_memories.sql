-- ============================================================================
-- Bubaly · SEED — Memories (family_memories 500 + trip_memories 500).
-- The memory timeline + trip scrapbook at volume. Idempotent via '[seed:mem]'
-- body marker (family_memories) / '[seed:mem]' note marker (trip_memories).
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  titles text[] := array['First day of school','Beach day','Birthday party','Snow day','Family dinner',
                        'Soccer win','Camping trip','Grandma''s visit','Movie night','Bike ride',
                        'Museum trip','Pumpkin patch','Graduation','New puppy','Summer BBQ'];
  kinds text[] := array['photo','note','milestone','video'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  delete from public.family_memories where family_id = v_family and body = '[seed:mem]';
  delete from public.trip_memories where family_id = v_family and note = '[seed:mem]';

  insert into public.family_memories (family_id, member_id, title, body, kind, memory_date, tags, is_favorite, status)
  select v_family,
    case when v_members is null then null else v_members[1 + (g.i % array_length(v_members,1))] end,
    titles[1 + (g.i % array_length(titles,1))] || ' #' || g.i,
    '[seed:mem]',
    kinds[1 + (g.i % array_length(kinds,1))],
    (current_date - (g.i % 730)),
    '{seed}',
    (g.i % 20 = 0),
    'active'
  from generate_series(1, n) as g(i);

  insert into public.trip_memories (family_id, member_id, title, note, location, memory_date)
  select v_family,
    case when v_members is null then null else v_members[1 + (g.i % array_length(v_members,1))] end,
    titles[1 + (g.i % array_length(titles,1))] || ' (trip #' || g.i || ')',
    '[seed:mem]',
    (array['Beach','Mountains','City','Lake','Grandma''s','Theme Park'])[1 + (g.i % 6)],
    (current_date - (g.i % 730))
  from generate_series(1, n) as g(i);

  raise notice 'Memories seeded % family + % trip rows for family %', n, n, v_family;
end $$;
