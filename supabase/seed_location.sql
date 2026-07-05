-- ============================================================================
-- FamilyOS · SEED — Location & Safety (family_places + member_locations +
-- location_events 500). Places (Home/School/Work…), current member locations,
-- and 500 arrive/leave/ping events. Idempotent via '[seed:loc]' markers.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  v_places  uuid[];
  n int := 500;
  place_names text[] := array['Home','School','Work','Grandma''s','Soccer Field','Library','Gym','Dance Studio'];
  events text[] := array['arrived','left','ping'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  if v_members is null then raise exception 'Family has no members (needed for location events).'; end if;

  delete from public.location_events where family_id = v_family and place_name like '%[seed:loc]%';
  delete from public.family_places where family_id = v_family and name like '%[seed:loc]%';
  delete from public.member_locations where family_id = v_family and address = '[seed:loc]';

  -- Places (one per name).
  insert into public.family_places (family_id, name, icon, address, latitude, longitude, radius_m, geofence_enabled)
  select v_family, pn || ' [seed:loc]', '📍', pn || ' address',
    37.77 + (row_number() over () * 0.01), -122.41 - (row_number() over () * 0.01), 150, true
  from unnest(place_names) as pn;
  select array_agg(id) into v_places from public.family_places where family_id = v_family and name like '%[seed:loc]%';

  -- 500 location events across members/places/types.
  insert into public.location_events (family_id, member_id, place_id, place_name, event_type, latitude, longitude, occurred_at)
  select v_family,
    v_members[1 + (g.i % array_length(v_members,1))],
    v_places[1 + (g.i % array_length(v_places,1))],
    place_names[1 + (g.i % array_length(place_names,1))] || ' [seed:loc]',
    events[1 + (g.i % array_length(events,1))]::location_event_type,
    37.77 + (g.i % 50) * 0.001, -122.41 - (g.i % 50) * 0.001,
    now() - ((g.i * 7) || ' minutes')::interval
  from generate_series(1, n) as g(i);

  -- Current member locations (upsert one row per member; not 500 — bounded by members).
  insert into public.member_locations (family_id, member_id, latitude, longitude, accuracy_m, battery, is_sharing, address, updated_at)
  select v_family, m, 37.77 + random()*0.05, -122.41 - random()*0.05, 8 + random()*20,
    20 + floor(random()*80)::int, true, '[seed:loc]', now()
  from unnest(v_members) as m;

  raise notice 'Location seeded % events (+places, member locations) for family %', n, v_family;
end $$;
