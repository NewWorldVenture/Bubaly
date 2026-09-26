-- ── A location row names the member who was actually there (0335) ──────────
--
-- `00420_family_location.sql` gave `member_locations` and `location_events` one
-- policy each, `FOR ALL … is_family_member(family_id)`. That predicate is blind
-- to `member_id`, while the application is strictly self-only: the header of
-- `updateMyLocation` (app/(app)/dashboard/locator/actions.ts L29) says "a member
-- can only post their own location", and all three writers pin
-- `member_id: c.active.member.id`. A child has a real login and /rest/v1 never
-- passes through app/, so the pin was advisory.
--
-- Note on shape, because the template for these probes asserts "the manager
-- write still works, the member write is refused" and that is NOT this guard:
-- 0335 is an IDENTITY pin, not a role gate. A manager-only policy was measured
-- and REFUSED THE CHILD'S OWN POST — the CENSUS-002 / autopilot_suggestions
-- mistake, and the reason 0215 left these two tables alone. So the legitimate
-- write asserted here is the SELF write, and it is asserted for the manager as
-- well as the child (§1, §2, §7); the refusal is asserted in both directions,
-- child-forging-parent AND parent-forging-child (§3-§6, §8).
--
-- Asserts:
--
--   1. a child can STILL post their OWN live position, and STILL take the
--      ON CONFLICT DO UPDATE branch that `setLocationSharing` upserts through —
--      a boundary that stops the honest caller is the wrong boundary;
--   2. a child can STILL log their OWN geofence arrival;
--   3. a child CANNOT post a position naming a sibling (a fresh row) nor
--      overwrite the parent's (the upsert's ON CONFLICT DO UPDATE branch);
--   4. a child CANNOT flip the parent's `is_sharing` off, which is how they
--      would take a parent off the family map;
--   5. a child CANNOT log an arrival in the parent's name — Find Phone and the
--      alerts strip render that row as genuine;
--   6. a child CANNOT wipe the household's history or every live position;
--   7. a MANAGER's own post still works — the positive control for the fix;
--   8. a MANAGER cannot forge the CHILD's either: identity, not role;
--   9. reads are UNCHANGED (asserted BEFORE the erasures below, so a run where
--      the wipe succeeds reports the wipe and not a phantom read regression) — the child still sees every family row, because the
--      map, Find Phone and the day-grouped history render for whoever is signed
--      in. Cross-family isolation still holds.
--  10. `anon` holds no INSERT on either table (0290's argument);
--  11. NEGATIVE CONTROL: drop ONLY 0335's guards inside the transaction and
--      require every forgery and both wipes to succeed again.
--
-- A note on how a refusal shows up: only INSERT (a WITH CHECK) raises
-- `insufficient_privilege`. A restrictive USING clause FILTERS rows, so a
-- refused UPDATE/DELETE returns 0 rows rather than an error — asserted by
-- row_count, not by an exception handler that would silently pass.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubalyv \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-location-says-who-was-actually-there-check.sql

\set FAM  '0c0a7000-0000-4000-8000-0000000f0c01'
\set OTH  '0c0a7000-0000-4000-8000-0000000f0c0e'
\set UP   '0c0a7000-0000-4000-8000-0000000f0c02'
\set UK   '0c0a7000-0000-4000-8000-0000000f0c03'
\set UO   '0c0a7000-0000-4000-8000-0000000f0c0f'
\set MP   '0c0a7000-0000-4000-8000-0000000f0c04'
\set MK   '0c0a7000-0000-4000-8000-0000000f0c05'
\set MS   '0c0a7000-0000-4000-8000-0000000f0c06'
\set US   '0c0a7000-0000-4000-8000-0000000f0c07'

begin;
set local lock_timeout = '30s';

insert into auth.users (id, email) values (:'UP','loc-probe-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','loc-probe-kid@example.com')    on conflict do nothing;
insert into auth.users (id, email) values (:'US','loc-probe-sibling@example.com')  on conflict do nothing;
insert into auth.users (id, email) values (:'UO','loc-probe-outsider@example.com') on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FAM','Locator Probe House',:'UP') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'OTH','Locator Probe Neighbours',:'UO') on conflict do nothing;

-- Creating a family auto-creates the creator's member row; adopt it so the ids
-- below are ours rather than whatever the trigger generated.
update public.family_members set id = :'MP', display_name = 'Parent', role = 'parent', is_active = true
 where family_id = :'FAM' and user_id = :'UP';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MK',:'FAM',:'UK','Kid','child',true) on conflict do nothing;
-- The sibling deliberately gets NO member_locations row: member_locations has
-- UNIQUE (member_id), so a forgery aimed at someone who already has a row would
-- hit the constraint before RLS and mask what this probe is measuring.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MS',:'FAM',:'US','Sibling','child',true) on conflict do nothing;

-- The parent's genuine live position and a genuine arrival, written the way
-- updateMyLocation writes them.
insert into public.member_locations (family_id, member_id, latitude, longitude, battery, is_sharing)
  values (:'FAM', :'MP', 51.5074, -0.1278, 88, true);
insert into public.location_events (family_id, member_id, place_name, event_type, latitude, longitude)
  values (:'FAM', :'MP', 'Home', 'arrived', 51.5074, -0.1278);

grant select, insert, update, delete on public.member_locations to authenticated;
grant select, insert, update, delete on public.location_events  to authenticated;

do $$
declare
  n int;
  failures text[] := '{}';
  fam      constant uuid := '0c0a7000-0000-4000-8000-0000000f0c01';
  oth      constant uuid := '0c0a7000-0000-4000-8000-0000000f0c0e';
  parent_u constant uuid := '0c0a7000-0000-4000-8000-0000000f0c02';
  kid_u    constant uuid := '0c0a7000-0000-4000-8000-0000000f0c03';
  m_parent constant uuid := '0c0a7000-0000-4000-8000-0000000f0c04';
  m_kid    constant uuid := '0c0a7000-0000-4000-8000-0000000f0c05';
  m_sib    constant uuid := '0c0a7000-0000-4000-8000-0000000f0c06';
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- Preconditions: the actor really is a non-manager member of this family.
  if not public.is_family_member(fam) then
    failures := array_append(failures, 'the probe''s child is not a member of the probe family — nothing below proves anything');
  end if;
  if public.can_manage_family(fam) then
    failures := array_append(failures, 'the probe''s child can manage the family — it is not the actor this guard is about');
  end if;

  -- 1. The child's OWN post. `updateMyLocation` upserts on member_id.
  begin
    insert into public.member_locations (family_id, member_id, latitude, longitude, battery, is_sharing)
      values (fam, m_kid, 40.7128, -74.0060, 71, true)
      on conflict (member_id) do update set latitude = excluded.latitude, is_sharing = excluded.is_sharing;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child can no longer post their OWN location — every child''s "Share Now" would 500, which is the autopilot_suggestions mistake');
  end;

  -- 1b. The same upsert again, so the ON CONFLICT DO UPDATE branch is exercised
  --     (this is the path `setLocationSharing` takes on every toggle).
  begin
    insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
      values (fam, m_kid, 40.7128, -74.0060, false)
      on conflict (member_id) do update set is_sharing = excluded.is_sharing, latitude = excluded.latitude;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child can no longer toggle their OWN sharing — the upsert''s DO UPDATE branch is refused');
  end;

  -- 2. The child's OWN geofence event, the safety-timeline entry.
  begin
    insert into public.location_events (family_id, member_id, place_name, event_type, latitude, longitude)
      values (fam, m_kid, 'School', 'arrived', 40.7128, -74.0060);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child crossing a geofence can no longer log their OWN arrival — the timeline loses exactly the entries it exists for');
  end;

  -- 3a. The forgery, fresh row: a live position for the SIBLING, who has none.
  begin
    insert into public.member_locations (family_id, member_id, latitude, longitude, battery, is_sharing)
      values (fam, m_sib, 1.0, 2.0, 5, true);
    failures := array_append(failures, 'a child PLANTED a live position for a sibling — Find Phone renders it with an "Open in Maps" link');
  exception when insufficient_privilege then null;
  end;

  -- 3b. The forgery, existing row: the same upsert the app makes, aimed at the
  --     PARENT. member_locations is UNIQUE (member_id), so this is the shape the
  --     reproduction measured as `UPDATE 1` — it takes the ON CONFLICT DO UPDATE
  --     branch, which RLS checks against the UPDATE policy's USING clause.
  begin
    insert into public.member_locations (family_id, member_id, latitude, longitude, battery, is_sharing)
      values (fam, m_parent, 1.0, 2.0, 5, true)
      on conflict (member_id) do update
        set latitude = excluded.latitude, longitude = excluded.longitude, battery = excluded.battery;
    failures := array_append(failures, 'a child OVERWROTE the parent''s live position — the family map plots the coordinates the child chose');
  exception when insufficient_privilege then null;
  end;

  -- 4. Taking the parent off the family map.
  update public.member_locations set is_sharing = false, latitude = null where member_id = m_parent;
  get diagnostics n = row_count;
  if n <> 0 then
    failures := array_append(failures, format('a child switched the parent off the family map (%s row(s) updated)', n));
  end if;

  -- 5. The forged arrival, which the alerts strip presents as genuine.
  begin
    insert into public.location_events (family_id, member_id, place_name, event_type, latitude, longitude)
      values (fam, m_parent, 'FORGED Bar', 'arrived', 9.0, 9.0);
    failures := array_append(failures, 'a child logged an arrival in the PARENT''s name — arrivalAlerts() renders it on /dashboard/locator');
  exception when insufficient_privilege then null;
  end;

  -- 9. Reads are untouched: the map and the history render for every member.
  select count(*) into n from public.member_locations where family_id = fam;
  if n < 2 then
    failures := array_append(failures, format('a child now reads only %s member_locations row(s) — the family map renders for whoever is signed in; narrowing SELECT is a product decision, not this migration''s', n));
  end if;
  select count(*) into n from public.location_events where family_id = fam;
  if n < 2 then
    failures := array_append(failures, format('a child now reads only %s location_events row(s) — the day-grouped history and the alerts strip read for every member', n));
  end if;

  -- 6. The erasures. No application path performs either.
  delete from public.location_events where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then
    failures := array_append(failures, format('a child DELETED %s location event(s) — the household''s safety timeline has no second copy', n));
  end if;
  delete from public.member_locations where family_id = fam and member_id = m_parent;
  get diagnostics n = row_count;
  if n <> 0 then
    failures := array_append(failures, format('a child DELETED the parent''s live position (%s row(s))', n));
  end if;

  -- 9b. And the boundary that already held still holds.
  begin
    insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
      values (oth, m_kid, 3.0, 3.0, true);
    failures := array_append(failures, 'a child wrote into ANOTHER family — cross-tenant isolation has regressed');
  exception when insufficient_privilege then null;
  end;

  -- 7. The manager's own post — the positive control for the fix.
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.member_locations (family_id, member_id, latitude, longitude, battery, is_sharing)
      values (fam, m_parent, 51.5, -0.13, 64, true)
      on conflict (member_id) do update set latitude = excluded.latitude, battery = excluded.battery;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not post their OWN location');
  end;
  begin
    insert into public.location_events (family_id, member_id, place_name, event_type, latitude, longitude)
      values (fam, m_parent, 'Work', 'arrived', 51.5, -0.13);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not log their OWN arrival');
  end;

  -- 8. Identity, not role: the parent cannot forge the child's either.
  begin
    insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
      values (fam, m_kid, 99.0, 99.0, true)
      on conflict (member_id) do update set latitude = excluded.latitude;
    failures := array_append(failures, 'a PARENT planted a live position for the child — the pin is a role check, not an identity check');
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.location_events (family_id, member_id, place_name, event_type)
      values (fam, m_kid, 'FORGED Detention', 'arrived');
    failures := array_append(failures, 'a PARENT logged an arrival in the child''s name — the pin is a role check, not an identity check');
  exception when insufficient_privilege then null;
  end;
  -- and the append-only half binds the manager too.
  update public.location_events set place_name = 'rewritten' where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then
    failures := array_append(failures, format('a MANAGER rewrote %s location event(s) — the timeline is meant to be append-only for clients', n));
  end if;

  -- 10. The grant layer, which a `to authenticated` policy cannot reach.
  perform set_config('role','postgres', true);
  if has_table_privilege('anon', 'public.member_locations', 'INSERT') then
    failures := array_append(failures, 'anon holds INSERT on member_locations');
  end if;
  if has_table_privilege('anon', 'public.location_events', 'INSERT') then
    failures := array_append(failures, 'anon holds INSERT on location_events');
  end if;

  -- ── 11. Negative control: prove this probe can SEE the defect ────────────
  -- Drop ONLY 0335's guards, leaving 00420's permissive policies exactly as
  -- they were, and require the escalation to work again. The outer rollback
  -- undoes this along with everything else.
  drop policy if exists member_locations_self_insert_guard      on public.member_locations;
  drop policy if exists member_locations_self_update_guard      on public.member_locations;
  drop policy if exists member_locations_self_delete_guard      on public.member_locations;
  drop policy if exists location_events_self_insert_guard       on public.location_events;
  drop policy if exists location_events_no_client_update_guard  on public.location_events;
  drop policy if exists location_events_no_client_delete_guard  on public.location_events;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  begin
    insert into public.member_locations (family_id, member_id, latitude, longitude, battery, is_sharing)
      values (fam, m_sib, 1.0, 2.0, 5, true)
      on conflict (member_id) do update set latitude = excluded.latitude, battery = excluded.battery;
  exception when insufficient_privilege then
    failures := array_append(failures, 'with 0335 dropped the child STILL could not plant a sibling''s position — this probe is decoration, not a boundary');
  end;
  begin
    insert into public.member_locations (family_id, member_id, latitude, longitude, battery, is_sharing)
      values (fam, m_parent, 1.0, 2.0, 5, true)
      on conflict (member_id) do update set latitude = excluded.latitude, battery = excluded.battery;
  exception when insufficient_privilege then
    failures := array_append(failures, 'with 0335 dropped the child STILL could not overwrite the parent''s position — this probe is decoration, not a boundary');
  end;
  begin
    insert into public.location_events (family_id, member_id, place_name, event_type, latitude, longitude)
      values (fam, m_parent, 'FORGED Bar', 'arrived', 9.0, 9.0);
  exception when insufficient_privilege then
    failures := array_append(failures, 'with 0335 dropped the child STILL could not forge an arrival — this probe has never been shown to fail');
  end;
  update public.member_locations set is_sharing = false where member_id = m_parent;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with 0335 dropped the child STILL could not switch the parent off the map — the UPDATE half of this probe is decoration');
  end if;
  delete from public.location_events where family_id = fam;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with 0335 dropped no history was wiped — the DELETE half of this probe is decoration');
  end if;

  perform set_config('role','postgres', true);
  select count(*) into n from public.member_locations
   where family_id = fam and member_id in (m_parent, m_sib) and battery = 5;
  if n = 0 then
    failures := array_append(failures, 'with the pin removed no forged position landed — this probe has never been shown to fail');
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a location row does not say who was actually there:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-location-says-who-was-actually-there: OK (a member posts and logs only as themselves, nobody writes for anyone else in either direction, the timeline is append-only for clients, reads and cross-family isolation are unchanged, anon holds no INSERT, negative control reproduced the forgery, the map wipe and the history wipe)';
end $$;

rollback;
