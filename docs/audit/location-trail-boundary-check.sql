-- ── 0325: the record of where a child went is not writable by that child ─────
--
-- 0215 hardened the safety tables and said why, in its own header:
--
--   "a future missed gate or a direct PostgREST call by a signed-in child could
--    still tamper with the call/message screening rules or the geofences that
--    drive location safety alerts."
--
-- It then fixed `family_places` — the geofences — and stated that
-- `member_locations` was "intentionally NOT changed" because a member must be
-- able to write their own position. `location_events` is not mentioned at all.
--
-- So the INPUT to the geofence system was protected and the OUTPUT was left
-- `FOR ALL TO authenticated USING (is_family_member(family_id))` from 00420.
-- "Self-location" is also not what member_locations enforced: `is_family_member`
-- is family-wide, so it governs everybody's row, not your own.
--
-- Measured before 0325, as a signed-in CHILD:
--   NOTICE: child erased 1 of their own arrival/departure event(s)
--   NOTICE: child forged an "arrived at School" event for themselves
--   NOTICE: child moved a SIBLING's live pin to (0,0)
--   NOTICE: child switched a SIBLING's location sharing off
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/location-trail-boundary-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
-- Audit C1-S8-02.
do $$
declare
  fam uuid := 'f0325000-0000-4000-8000-00000000fa01';
  up  uuid := 'f0325000-0000-4000-8000-00000000c001';  -- parent
  uk  uuid := 'f0325000-0000-4000-8000-00000000c002';  -- child (the attacker)
  us  uuid := 'f0325000-0000-4000-8000-00000000c003';  -- sibling (the victim)
  mp uuid; mk uuid; ms uuid; ev uuid; plc uuid;
  n int; refused boolean; holes text[] := '{}';
begin
  insert into public.families (id, name) values (fam, '0325 location trail') on conflict do nothing;
  insert into auth.users (id, email) values
    (up, 'p0325@example.test'), (uk, 'k0325@example.test'), (us, 's0325@example.test')
    on conflict do nothing;
  delete from public.location_events  where family_id = fam;
  delete from public.member_locations where family_id = fam;
  delete from public.family_places    where family_id = fam;
  delete from public.family_members   where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, up, 'Parent', 'parent', true) returning id into mp;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uk, 'Kid', 'child', true) returning id into mk;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, us, 'Sibling', 'child', true) returning id into ms;

  insert into public.family_places (family_id, name, latitude, longitude, radius_m, created_by)
    values (fam, 'School', 40.0, -74.0, 150, up) returning id into plc;

  -- The trail the parent's safety alerts wrote about the child, 02:00.
  insert into public.location_events
    (family_id, member_id, place_id, place_name, event_type, latitude, longitude, occurred_at)
    values (fam, mk, plc, 'School', 'left', 40.0, -74.0, now() - interval '1 hour')
    returning id into ev;

  -- The sibling is sharing their position.
  insert into public.member_locations
    (family_id, member_id, latitude, longitude, place_id, is_sharing)
    values (fam, ms, 41.5, -73.5, null, true);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', uk::text, true);
  if auth.uid() is distinct from uk then
    raise exception '0325: impersonation failed — auth.uid() is %, expected the child; this probe is not testing what it claims', auth.uid();
  end if;

  -- ── 1. Erasing your own trail ─────────────────────────────────────────────
  -- The 2am departure is precisely the row a parent must be able to rely on.
  delete from public.location_events where id = ev;
  get diagnostics n = row_count;
  if n > 0 then
    holes := holes || format('child erased %s of their own arrival/departure event(s)', n);
    raise notice 'child erased % of their own arrival/departure event(s)', n;
  end if;

  -- ── 2. Forging an arrival ─────────────────────────────────────────────────
  -- Content is self-asserted either way (you control the GPS you post), so the
  -- boundary that matters is WHOSE row you may write. This one is still self.
  refused := false;
  begin
    insert into public.location_events
      (family_id, member_id, place_id, place_name, event_type, latitude, longitude, occurred_at)
      values (fam, mk, plc, 'School', 'arrived', 40.0, -74.0, now());
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise notice 'child forged an "arrived at School" event for themselves'; end if;

  -- ── 3. Moving a SIBLING's live pin ────────────────────────────────────────
  -- This is the sharp one: the parent's map of a DIFFERENT child, falsified.
  refused := false;
  begin
    update public.member_locations set latitude = 0, longitude = 0 where member_id = ms;
    get diagnostics n = row_count;
  exception when insufficient_privilege then refused := true; n := 0;
  end;
  if n > 0 then
    holes := holes || 'child moved a SIBLING''s live pin'::text;
    raise notice 'child moved a SIBLING''s live pin to (0,0)';
  end if;

  -- ── 4. Switching a SIBLING's sharing off ──────────────────────────────────
  refused := false;
  begin
    update public.member_locations set is_sharing = false where member_id = ms;
    get diagnostics n = row_count;
  exception when insufficient_privilege then refused := true; n := 0;
  end;
  if n > 0 then
    holes := holes || 'child switched a SIBLING''s location sharing off'::text;
    raise notice 'child switched a SIBLING''s location sharing off';
  end if;

  -- ── 5. Re-pointing your own row at a sibling ──────────────────────────────
  -- C1-S6-08's lesson: an ownership test in `using` alone governs the row you
  -- started from. This attack passes `using` (the row IS mine) and is refused
  -- only by `with check` (the row I produce is not). It re-points at the PARENT,
  -- who has no location row of their own — aimed at the sibling, the unique
  -- index on member_id would refuse it first and the probe would credit RLS
  -- with a constraint's work.
  insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
    values (fam, mk, 40.2, -74.2, true)
    on conflict (member_id) do update set latitude = excluded.latitude;
  refused := false;
  begin
    update public.member_locations set member_id = mp where member_id = mk;
    get diagnostics n = row_count;
  exception when insufficient_privilege then refused := true; n := 0;
  end;
  if n > 0 then
    holes := holes || 'child re-pointed their own location row at another member'::text;
    raise notice 'child re-pointed their own location row at another member';
  end if;

  -- ── 6. Filing an event in someone else's name ─────────────────────────────
  refused := false;
  begin
    insert into public.location_events
      (family_id, member_id, place_id, place_name, event_type, latitude, longitude, occurred_at)
      values (fam, ms, plc, 'School', 'arrived', 40.0, -74.0, now());
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    holes := holes || 'child filed a location event in a SIBLING''s name'::text;
    raise notice 'child filed a location event in a SIBLING''s name';
  end if;

  -- ── What must still work ──────────────────────────────────────────────────
  -- A fix that breaks the product is not a fix: updateMyLocation() runs on the
  -- member's OWN session, so posting your own position must stay possible.
  insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
    values (fam, mk, 40.1, -74.1, true)
    on conflict (member_id) do update set latitude = excluded.latitude, longitude = excluded.longitude;
  insert into public.location_events
    (family_id, member_id, place_id, place_name, event_type, latitude, longitude, occurred_at)
    values (fam, mk, plc, 'School', 'arrived', 40.1, -74.1, now());
  -- And every family member still READS the whole family's map.
  select count(*) into n from public.member_locations where family_id = fam;
  if n < 2 then
    raise exception '0325: the child can no longer see the family map (% rows) — the fix went too far', n;
  end if;

  -- The upsert the action actually issues — insert THEN conflict-update — must
  -- pass both the INSERT with-check and the UPDATE using+with-check.
  insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
    values (fam, mk, 40.3, -74.3, true)
    on conflict (member_id) do update
      set latitude = excluded.latitude, longitude = excluded.longitude, is_sharing = excluded.is_sharing;
  -- And setLocationSharing(false): the same upsert, nulling the coordinates.
  insert into public.member_locations (family_id, member_id, is_sharing, latitude, longitude, place_id)
    values (fam, mk, false, null, null, null)
    on conflict (member_id) do update
      set is_sharing = excluded.is_sharing, latitude = null, longitude = null, place_id = null;

  reset role;

  -- deletePlace() is a manager action that fires ON DELETE SET NULL against
  -- location_events. There is no UPDATE policy on that table, so if a foreign
  -- key's referential action were subject to RLS, deleting a place would now
  -- fail — the exact way a boundary fix breaks a shipped feature.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', up::text, true);
  delete from public.family_places where id = plc;
  select count(*) into n from public.location_events where family_id = fam and place_id is not null;
  if n > 0 then
    raise exception '0325: deleting a place left % event(s) pointing at it', n;
  end if;
  reset role;

  -- Account deletion cascades from families and must not be held up either.
  delete from public.families where id = fam;
  select count(*) into n from public.location_events where family_id = fam;
  if n > 0 then
    raise exception '0325: deleting the family left % location event(s) behind', n;
  end if;

  if array_length(holes, 1) is not null then
    raise exception '0325: the location trail is writable by its subject: %', array_to_string(holes, '; ');
  end if;
  raise notice '0325 OK — a child may post their own position and read the family map, and nothing else';
end $$;
