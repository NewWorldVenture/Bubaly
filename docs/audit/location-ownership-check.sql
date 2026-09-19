-- Whose phone says where they are.
--
-- app/(app)/dashboard/locator/actions.ts states the rule in its own comment:
--
--   * Strictly self-only — a member can only post their own location.
--
-- and the action honours it — `member.id` comes from `requireUserContext()`,
-- never from the caller's input. Before 0319 that was the ONLY place it held.
-- Both `member_locations` and `location_events` carried one `FOR ALL` policy
-- checking `is_family_member(family_id)` and nothing about `member_id`, while
-- `authenticated` holds INSERT/UPDATE/DELETE on both — and the browser has a
-- direct line to them, since lib/realtime/published-tables.ts publishes both and
-- components/modules/locator-module.tsx subscribes from the client. A guard in
-- the server action is not a boundary when the table is reachable without it.
--
-- The positive controls matter more here than usual, because the obvious fix is
-- the wrong one. A device posting its own position is the ORDINARY path and it
-- runs under the member's own JWT, so a managers-only guard would pass every
-- "a child cannot…" assertion below while silently ending location reporting
-- for everyone who is not a manager. Assertions 1, 2 and 8 exist to fail if
-- that ever happens, and 9 asserts the shared family map still works.
--
-- Judged on ROW COUNTS where the refusal is a filter and on the exception where
-- it is a with-check: a restrictive `using` clause makes an UPDATE or DELETE
-- match nothing and SUCCEED with zero rows, while a restrictive `with check`
-- RAISES 42501. Assertion 7 accepts either, because either one means the row
-- was not re-attributed.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-00000000c001';
  pa_uid uuid := '00000000-0000-4000-8000-00000000c0a1';
  ch_uid uuid := '00000000-0000-4000-8000-00000000c0a2';
  sb_uid uuid := '00000000-0000-4000-8000-00000000c0a3';
  pa_mid uuid;
  ch_mid uuid;
  sib_mid uuid;
  n      int;
  lat    double precision;
  failures int := 0;
begin
  -- Repeatable: this probe owns every row under `fam`.
  delete from public.location_events  where family_id = fam;
  delete from public.member_locations where family_id = fam;

  insert into auth.users (id, email) values
    (pa_uid, 'locator-parent@example.com'), (ch_uid, 'locator-child@example.com'),
    (sb_uid, 'locator-sibling@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Locator', pa_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, pa_uid, 'Parent', 'parent', true),
    (fam, ch_uid, 'Child',  'child',  true),
    (fam, sb_uid, 'Sibling','child',  true)
  on conflict do nothing;
  select id into pa_mid from public.family_members where family_id = fam and user_id = pa_uid;
  select id into ch_mid  from public.family_members where family_id = fam and user_id = ch_uid;
  select id into sib_mid from public.family_members where family_id = fam and user_id = sb_uid;

  -- The parent is really at home.
  insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
    values (fam, pa_mid, 51.5, -0.12, true);

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', ch_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- 1. A child posts their OWN location. This is the product; it must work.
  begin
    insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
      values (fam, ch_mid, 51.49, -0.13, true);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a child could not post their own location (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not post their own location (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. And update it as they move. Also the product.
  begin
    update public.member_locations set latitude = 51.48 where member_id = ch_mid;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a child could not update their own location (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not update their own location (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 3. But not rewrite where the PARENT is. The map must not be made to lie.
  begin
    update public.member_locations set latitude = 0, longitude = 0, address = 'Nowhere'
     where member_id = pa_mid;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child rewrote the parent''s live location (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Nor remove the parent from the map altogether.
  begin
    delete from public.member_locations where member_id = pa_mid;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child deleted the parent''s live location row (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Nor invent somewhere the parent has been. lib/notifications/actions.ts
  --    links location_events as the family's safety timeline and
  --    lib/ai/context/policy.ts feeds it to a model as "location history", so a
  --    fabricated row is repeated back to the family as fact.
  begin
    insert into public.location_events (family_id, member_id, place_name, event_type, occurred_at)
      values (fam, pa_mid, 'Casino', 'arrived', now());
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child fabricated a location event attributed to the parent (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. A child's own event is theirs to write — the server action inserts these
  --    under the member's JWT on every geofence crossing, so a guard that
  --    blocked it would stop the timeline recording anything at all.
  begin
    insert into public.location_events (family_id, member_id, place_name, event_type, occurred_at)
      values (fam, ch_mid, 'School', 'arrived', now());
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a child could not record their own arrival (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not record their own arrival (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 7. Nor reach another member's row by RE-ATTRIBUTION rather than by edit. A
  --    `using`-only guard stops 3 and 4 and still permits this, which arrives
  --    at the same place: the child's own row, relabelled as somebody else's.
  --
  --    Aimed at the SIBLING, who has no location row, rather than at the
  --    parent, who does. member_locations is UNIQUE on member_id, so pointing
  --    this at the parent would be refused by that constraint (23505) whether
  --    or not the policy held — the probe would pass while testing nothing.
  begin
    update public.member_locations set member_id = sib_mid where member_id = ch_mid;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child re-attributed their own location row to a sibling (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 8. The shared family map is the feature: a child still SEES the parent.
  select latitude into lat from public.member_locations where member_id = pa_mid;
  if lat is null then
    raise warning 'CONTROL FAILED: a child can no longer see the parent on the family map';
    failures := failures + 1;
  end if;

  reset role;

  -- What the map reads is still what the parent's phone reported.
  select latitude into lat from public.member_locations where member_id = pa_mid;
  if lat is distinct from 51.5 then
    raise warning 'BREACH: the parent''s position on the map is now %', lat;
    failures := failures + 1;
  end if;
  select count(*) into n from public.location_events
   where member_id = pa_mid and place_name = 'Casino';
  if n <> 0 then
    raise warning 'BREACH: the parent''s safety timeline carries % event(s) they did not make', n;
    failures := failures + 1;
  end if;

  -- 9. A manager still manages any member's row, or the guard has closed the
  --    product for the people who administer it.
  perform set_config('request.jwt.claim.sub', pa_uid::text, true);
  set local role authenticated;
  begin
    update public.member_locations set is_sharing = false where member_id = ch_mid;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not stop a child sharing their location (rows: %)', n;
      failures := failures + 1;
    end if;
    delete from public.member_locations where member_id = ch_mid;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not remove a child''s location row (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not manage a location row (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'location-ownership: % assertion(s) failed', failures;
  end if;
  raise notice 'location-ownership: OK — a member posts their own position, and cannot move, erase or invent anyone else''s';
end
$probe$;
