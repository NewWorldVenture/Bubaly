-- Behavioural proof for 0308, run as real `authenticated` sessions under RLS.
--
-- `app/(app)/dashboard/locator/actions.ts:30` says "Strictly self-only — a
-- member can only post their own location", and the server action keeps that
-- promise. The DATABASE did not: member_locations and location_events were
-- `for all using (is_family_member(family_id))` and every write verb on
-- safety_check_ins carried the same predicate. The locator surfaces talk to
-- PostgREST directly with the anon key, so the action was never the boundary.
--
-- The two cases worth naming are the TRAIL ones: a child erasing their own
-- "left School" event, and any member deleting somebody else's "I am safe".
-- A trail you can delete is not a trail.
--
-- Reads are deliberately family-wide throughout and asserted so — seeing where
-- the family is IS the feature.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare
  fam        uuid := 'ffff1111-0000-4000-8000-00000000000f';
  parent_uid uuid := 'f1000000-0000-4000-8000-000000000001';
  kid_uid    uuid := 'f1000000-0000-4000-8000-000000000002';
  parent_mid uuid;
  kid_mid    uuid;
  ev         uuid;
  chk        uuid;
  n          int;
  v_lat      double precision;
  v_share    boolean;
begin
  -- Re-runnable against a database that already holds a previous run's rows.
  delete from public.location_events   where family_id = fam;
  delete from public.safety_check_ins  where family_id = fam;
  delete from public.member_locations  where family_id = fam;
  delete from public.family_members    where user_id in (parent_uid, kid_uid);
  delete from public.families          where id = fam;

  insert into public.families (id, name) values (fam, 'Locator');
  insert into auth.users (id, email) values (parent_uid, 'fp@example.test'), (kid_uid, 'fk@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, kid_uid, 'Kid', 'child', true) returning id into kid_mid;

  -- ── As the PARENT: their own dot, their own trail, their own check-in ────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
  values (fam, parent_mid, 51.5, -0.12, true);
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer post their own location (%)', n;
  end if;
  insert into public.location_events (family_id, member_id, event_type, place_name)
  values (fam, parent_mid, 'arrived', 'Work') returning id into ev;
  insert into public.safety_check_ins (family_id, member_id, status, created_by)
  values (fam, parent_mid, 'safe', parent_uid) returning id into chk;

  -- ── As the CHILD ─────────────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', kid_uid::text, true);
  set local role authenticated;

  -- Positive control first: the map is the feature. The child SEES everyone.
  select count(*) into n from public.member_locations where family_id = fam;
  if n = 0 then
    raise exception 'a child can no longer see the family map';
  end if;

  -- 1. Cannot move a parent's dot. Before 0308 this was INSERT/UPDATE 1.
  update public.member_locations set latitude = 0, longitude = 0 where member_id = parent_mid;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child moved a parent''s dot on the family map (%)', n;
  end if;
  select latitude into v_lat from public.member_locations where member_id = parent_mid;
  if v_lat is distinct from 51.5 then
    raise exception 'the parent''s coordinates changed despite the refusal (now %)', v_lat;
  end if;

  -- 2. Cannot take a parent off the map.
  update public.member_locations set is_sharing = false where member_id = parent_mid;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child stopped a parent sharing their location (%)', n;
  end if;
  select is_sharing into v_share from public.member_locations where member_id = parent_mid;
  if v_share is not true then
    raise exception 'the parent was taken off the map despite the refusal';
  end if;

  -- 3. Cannot fabricate somebody else's arrival — which notifies the family
  --    as urgent.
  begin
    insert into public.location_events (family_id, member_id, event_type, place_name)
    values (fam, parent_mid, 'arrived', 'Nowhere');
    raise exception 'a child fabricated an arrival for another member';
  exception when insufficient_privilege then
    null;
  end;

  -- 4. Cannot erase the trail — not a parent's, and not their own. This is the
  --    one the geofence exists for.
  insert into public.location_events (family_id, member_id, event_type, place_name)
  values (fam, kid_mid, 'left', 'School');
  delete from public.location_events where member_id = kid_mid;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child erased their own departure event (%)', n;
  end if;
  delete from public.location_events where id = ev;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child erased a parent''s location event (%)', n;
  end if;

  -- 5. Cannot delete somebody else's "I am safe". The check-in view's
  --    remove(id) deletes by id with no author check at all.
  delete from public.safety_check_ins where id = chk;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a parent''s safety check-in (%)', n;
  end if;
  select count(*) into n from public.safety_check_ins where id = chk;
  if n <> 1 then
    raise exception 'the check-in is gone despite the refusal';
  end if;

  -- Positive controls: everything the child legitimately does still works.
  insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
  values (fam, kid_mid, 51.4, -0.1, true);
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a child can no longer post their own location (%)', n;
  end if;
  update public.member_locations set is_sharing = false where member_id = kid_mid;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a child can no longer stop sharing their own location (%)', n;
  end if;
  insert into public.safety_check_ins (family_id, member_id, status, created_by)
  values (fam, kid_mid, 'safe', kid_uid);
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a child can no longer check in (%)', n;
  end if;
  delete from public.safety_check_ins where member_id = kid_mid;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a child can no longer withdraw their own check-in (%)', n;
  end if;

  -- ── As the PARENT: a manager still clears a trail and a stale dot ────────
  reset role;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  delete from public.location_events where member_id = kid_mid;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer clear a location trail (%)', n;
  end if;
  delete from public.member_locations where member_id = kid_mid;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer remove a stale location row (%)', n;
  end if;

  reset role;
  raise notice 'locator-write-boundary-check OK: only your own dot, an append-only trail, and nobody deletes another''s check-in; the family map still shows everyone';
end $$;
