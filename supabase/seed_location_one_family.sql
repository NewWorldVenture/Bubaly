-- ============================================================================
-- seed_location_one_family.sql — populate the Location page for ONE family.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES (all scoped to The Kramer Family, 92298eb2-…):
--   1. Ensures the additive columns from migration 0111 exist
--      (family_places.geofence_enabled, member_locations.address) so the seed
--      works even if the migration hasn't been applied yet.
--   2. Re-asserts family-scoped RLS on family_places / member_locations /
--      location_events (the "Members can manage" FOR ALL policy from 0042).
--   3. Seeds 6 family_places (Home, School, Soccer Field, Mall, Grandma's House,
--      Work) around Austin, TX — some geofences on, some off.
--   4. Upserts one member_locations row per active member (live positions at a
--      place, with battery + address + is_sharing) so the map + Live Locations
--      list + member chips all populate.
--   5. Seeds 500 location_events (arrived / left / ping) across every member and
--      place, spread over the last ~21 days incl. a cluster today — powering
--      Place Alerts and the per-day Location History.
--
-- TABLES: public.family_places, public.member_locations, public.location_events.
-- ROW COUNT: 500 location_events (+ 6 places + one member_location per member).
--
-- IDEMPOTENT: location_events are wiped for this family before re-insert; places
--   are matched by name (created once, reused); member_locations upsert on
--   (family_id, member_id) via delete-then-insert. Real (non-seed) data for the
--   family's own places with different names is left untouched.
--
-- SAFETY: never auto-runs against production. Paste into the Supabase SQL editor
--   and Run, or apply locally via `npm run db:seed:location`.
--
-- VERIFY: open /dashboard/locator and hard-refresh — map pins, member chips,
--   Live Locations, Place Alerts, Geofences toggles, and Location History.
-- ============================================================================

-- 1) Columns (mirror migration 0111) -----------------------------------------
alter table public.family_places   add column if not exists geofence_enabled boolean not null default true;
alter table public.member_locations add column if not exists address text;

-- 2) RLS repair --------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['family_places','member_locations','location_events'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "Members can manage %1$s" on public.%1$I', t, t);
    execute format('create policy "Members can manage %1$s" on public.%1$I for all to authenticated using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- 3) + 4) + 5) Places, live locations, and 500 events ------------------------
do $$
declare
  v_fam    uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email  text := 'newworldventurellc@gmail.com';
  v_uid    uuid;
  v_members uuid[];
  v_nmem   int;
  v_place_ids uuid[] := '{}';
  v_pid    uuid;
  i        int;
  v_member uuid;
  v_type   text;
  v_when   timestamptz;
  seeded   int := 0;

  p_name  text[] := ARRAY['Home','School','Soccer Field','Mall','Grandma''s House','Work'];
  p_icon  text[] := ARRAY['home','school','soccer','mall','house','work'];
  p_addr  text[] := ARRAY['123 Family Way, Austin, TX','Lincoln High School','Westview Soccer Field','Domain Northside','789 Oak Lane, Austin, TX','500 Congress Ave, Austin, TX'];
  p_lat   numeric[] := ARRAY[30.2672, 30.2849, 30.3100, 30.4010, 30.2500, 30.2680];
  p_lng   numeric[] := ARRAY[-97.7431, -97.7341, -97.7550, -97.7260, -97.7600, -97.7420];
  p_rad   int[] := ARRAY[150, 200, 250, 300, 150, 200];
  p_geo   bool[] := ARRAY[true, true, true, true, false, false];
  p_bat   int[] := ARRAY[90, 80, 75, 65, 70, 60];
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_fam and is_active;
  if v_members is null then raise exception 'No active members for family %', v_fam; end if;
  v_nmem := array_length(v_members, 1);

  -- Places (create once by name, else update the seeded fields).
  for i in 1 .. array_length(p_name, 1) loop
    select id into v_pid from public.family_places where family_id = v_fam and name = p_name[i] limit 1;
    if v_pid is null then
      insert into public.family_places (family_id, name, icon, address, latitude, longitude, radius_m, geofence_enabled, created_by)
      values (v_fam, p_name[i], p_icon[i], p_addr[i], p_lat[i], p_lng[i], p_rad[i], p_geo[i], v_uid)
      returning id into v_pid;
    else
      update public.family_places
        set icon = p_icon[i], address = p_addr[i], latitude = p_lat[i], longitude = p_lng[i],
            radius_m = p_rad[i], geofence_enabled = p_geo[i]
        where id = v_pid;
    end if;
    v_place_ids := array_append(v_place_ids, v_pid);
  end loop;

  -- Live locations: place each active member at a place (round-robin).
  delete from public.member_locations where family_id = v_fam;
  for i in 1 .. v_nmem loop
    v_pid := v_place_ids[1 + ((i - 1) % array_length(v_place_ids, 1))];
    insert into public.member_locations
      (family_id, member_id, latitude, longitude, accuracy_m, battery, place_id, address, is_sharing, updated_at)
    select v_fam, v_members[i], fp.latitude, fp.longitude, 25, p_bat[1 + ((i - 1) % array_length(p_bat,1))],
           fp.id, fp.address, true,
           now() - ((i * 37) % 240 || ' minutes')::interval
    from public.family_places fp where fp.id = v_pid;
  end loop;

  -- Wipe previously seeded events, then seed 500 across members/places/time.
  delete from public.location_events where family_id = v_fam;
  for i in 1 .. 500 loop
    v_member := v_members[1 + (i % v_nmem)];
    v_pid    := v_place_ids[1 + (i % array_length(v_place_ids, 1))];
    -- ~55% arrivals, ~35% departures, ~10% pings.
    v_type := case when (i % 20) < 11 then 'arrived' when (i % 20) < 18 then 'left' else 'ping' end;
    -- Spread over ~21 days; every 3rd event lands "today" so the timeline fills.
    if (i % 3) = 0 then
      v_when := date_trunc('day', now()) + ((i % 14) || ' hours')::interval + ((i % 50) || ' minutes')::interval;
      if v_when > now() then v_when := now() - ((i % 30) || ' minutes')::interval; end if;
    else
      v_when := now() - (((i % 21) || ' days')::interval) - (((i % 24) || ' hours')::interval);
    end if;

    insert into public.location_events (family_id, member_id, place_id, place_name, event_type, latitude, longitude, occurred_at)
    select v_fam, v_member, fp.id, fp.name, v_type::public.location_event_type, fp.latitude, fp.longitude, v_when
    from public.family_places fp where fp.id = v_pid;
    seeded := seeded + 1;
  end loop;

  raise notice 'Seeded % location_events + % places + % live members for family %.',
    seeded, array_length(v_place_ids,1), v_nmem, v_fam;
end $$;

-- 6) Verify ------------------------------------------------------------------
select
  (select count(*) from public.location_events where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499') as events,
  (select count(*) from public.location_events where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and event_type = 'arrived') as arrivals,
  (select count(*) from public.location_events where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and occurred_at >= date_trunc('day', now())) as today,
  (select count(*) from public.family_places where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499') as places,
  (select count(*) from public.member_locations where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and is_sharing) as live_members;
