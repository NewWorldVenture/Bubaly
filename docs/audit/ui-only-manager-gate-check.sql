-- Four modules that say "manager" and a database that does not.
--
-- Each of these components declares `canEdit = isManager(role)` and then writes
-- its table STRAIGHT FROM THE BROWSER with the viewer's own JWT. `canEdit` only
-- decides whether a button renders, and a hidden button is not a boundary:
--
--   rides-module.tsx     -> rides        (add/edit/delete/mark-completed, all
--                                         inside `canEdit` at line 247)
--   renewals-module.tsx  -> renewals     (add/edit/delete/mark-renewed, 210)
--   signups-module.tsx   -> opportunities(add/edit/delete/mark-registered, 235)
--   trips-module.tsx     -> trips        (add/edit/delete, 223)
--                        -> trip_items   (add 255, remove 277)
--
-- `trip_items` is the one that is NOT a straight manager table, and the reason
-- this probe exists rather than a blanket sweep. Its done-tick —
-- `toggleItem` at line 267 — sits OUTSIDE `canEdit`: any member may check a
-- packing item off. A blanket manager guard would have closed that, so what is
-- guarded there is the item's CONTENT, not the tick. Both are asserted.
--
-- Judged on ROW COUNTS: a write refused by nothing simply lands, and an
-- exception-only assertion would report a boundary that is not there.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-0000000ce101';
  parent_uid uuid := '00000000-0000-4000-8000-0000000ce1a1';
  child_uid  uuid := '00000000-0000-4000-8000-0000000ce1a2';
  child_mid uuid;
  ride uuid;
  renewal uuid;
  spare_renewal uuid;
  signup uuid;
  trip uuid;
  item uuid;
  spare_item uuid;
  txt text;
  n int;
  failures int := 0;
begin
  delete from public.trip_items where family_id = fam;
  delete from public.trips where family_id = fam;
  delete from public.rides where family_id = fam;
  delete from public.renewals where family_id = fam;
  delete from public.opportunities where family_id = fam;

  insert into auth.users (id, email) values
    (parent_uid, 'gate-parent@example.com'), (child_uid, 'gate-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'UI Gates', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  insert into public.rides (family_id, title, ride_date, status, created_by)
    values (fam, 'Soccer practice', current_date, 'planned', parent_uid) returning id into ride;
  insert into public.renewals (family_id, title, expires_at, status, created_by)
    values (fam, 'Passport', current_date + 30, 'active', parent_uid) returning id into renewal;
  -- A second renewal, so the DELETE assertion cannot destroy the row the
  -- manager control depends on.
  insert into public.renewals (family_id, title, expires_at, status, created_by)
    values (fam, 'Car registration', current_date + 60, 'active', parent_uid) returning id into spare_renewal;
  insert into public.opportunities (family_id, title, status, created_by)
    values (fam, 'Summer camp', 'interested', parent_uid) returning id into signup;
  insert into public.trips (family_id, name, status, created_by)
    values (fam, 'Lake house', 'planning', parent_uid) returning id into trip;
  insert into public.trip_items (family_id, trip_id, kind, label, is_done, created_by)
    values (fam, trip, 'packing', 'Sunscreen', false, parent_uid) returning id into item;
  -- A second item, so the DELETE assertion cannot destroy the row the tick
  -- control below depends on.
  insert into public.trip_items (family_id, trip_id, kind, label, is_done, created_by)
    values (fam, trip, 'packing', 'Towels', false, parent_uid) returning id into spare_item;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- 1. Ticking a packing item off is theirs to do — the positive control.
  --    toggleItem sits outside `canEdit`, so a blanket guard on trip_items
  --    would have closed a working feature rather than a hole.
  begin
    update public.trip_items set is_done = true where id = item;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a member could not tick a packing item (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a member could not tick a packing item (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. But not rewrite what the item IS.
  begin
    update public.trip_items set label = 'Fireworks', kind = 'todo' where id = item;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child rewrote a trip item (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Nor add one.
  begin
    insert into public.trip_items (family_id, trip_id, kind, label, created_by)
      values (fam, trip, 'packing', 'Slingshot', child_uid);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child added a trip item (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Nor remove one.
  begin
    delete from public.trip_items where id = spare_item;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child deleted a trip item (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5-8. The four straight manager tables. Every write in each module sits
  --      inside `canEdit`, so none of these is a member action at all.
  begin
    update public.rides set status = 'cancelled', pickup_time = '23:00' where id = ride;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child rescheduled and cancelled a ride (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.renewals where id = spare_renewal;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child deleted a renewal reminder (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.opportunities set status = 'registered' where id = signup;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child registered the family for a signup (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.trips set destination = 'Vegas', start_date = current_date where id = trip;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child changed the family trip (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  reset role;

  -- 9. What the family would see is still what the parent set.
  select label into txt from public.trip_items where id = item;
  if txt is distinct from 'Sunscreen' then
    raise warning 'BREACH: the trip item now reads %', txt;
    failures := failures + 1;
  end if;
  select count(*) into n from public.renewals where id = spare_renewal;
  if n <> 1 then
    raise warning 'BREACH: the renewal reminder is gone';
    failures := failures + 1;
  end if;

  -- 10. A manager still runs all five, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    update public.rides set status = 'completed' where id = ride;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not complete a ride (rows: %)', n;
      failures := failures + 1;
    end if;
    update public.renewals set expires_at = current_date + 365 where id = renewal;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not roll a renewal forward (rows: %)', n;
      failures := failures + 1;
    end if;
    update public.opportunities set status = 'registered' where id = signup;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not register a signup (rows: %)', n;
      failures := failures + 1;
    end if;
    update public.trips set destination = 'Tahoe' where id = trip;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not edit a trip (rows: %)', n;
      failures := failures + 1;
    end if;
    insert into public.trip_items (family_id, trip_id, kind, label, created_by)
      values (fam, trip, 'packing', 'Charger', parent_uid);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not add a trip item (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not run these modules (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'ui-only-manager-gate: % assertion(s) failed', failures;
  end if;
  raise notice 'ui-only-manager-gate: OK — a member may tick a packing item, and may not run these modules';
end
$probe$;
