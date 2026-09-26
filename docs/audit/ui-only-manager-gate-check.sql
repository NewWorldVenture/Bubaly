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
--
-- NEGATIVE CONTROL, and it runs FIRST, before any of the eight refusals
-- ---------------------------------------------------------------------------
-- The rule under test is 0310's, and 0310 is the LAST word on it.
-- `0310_ui_only_manager_gates_are_enforced.sql` created every guard named here;
-- no later migration touches these five tables' policies or triggers. Grepping
-- `manager_insert_guard|manager_update_guard|manager_delete_guard|
-- trip_item_content_guard` across supabase/migrations puts the last hit at
-- 0310, and grepping the five table names puts the only later hits in 0342 and
-- 0276, both of which are prose in a comment. This matters: replaying an old
-- migration in your head is how this audit once credited a guard a later
-- migration had replaced, when 0297 re-created the child_logins policy on a
-- different predicate than 0105 had.
--
-- TWO MECHANISMS, both keyed on the SAME question, `can_manage_family(family_id)`:
--
--   * rides, renewals, opportunities and trips carry RESTRICTIVE RLS POLICIES
--     for insert/update/delete (0310 lines 44-69), and trip_items carries them
--     for insert/delete (0310 lines 78-86). Restrictive policies AND with the
--     permissive "Members can manage X" policies from 0027/0029/0031/0033, so
--     none of those can grant past them;
--   * check 2 — the trip_items CONTENT update — is NOT RLS at all. It is the
--     BEFORE UPDATE TRIGGER `trg_trip_item_content_guard` (0310 lines 88-128),
--     which raises 42501 by hand when a non-manager changes any column other
--     than is_done. UPDATE on trip_items deliberately carries NO restrictive
--     policy, because a member must keep the tick — that is what check 1 is.
--
-- One question is all either mechanism asks, so the control is the same child
-- running the same seven statements — same tables, same verbs, SAME COLUMNS —
-- in a SECOND family where that child IS a manager. All seven must land: the
-- same actor, through the same predicate, with the answer the other way.
--
-- Without it, checks 2-8 are refusals with no attribution:
--
--   * checks 2 and 3 catch `insufficient_privilege` and credit the content
--     trigger and the INSERT policy's WITH CHECK — but a missing or revoked
--     table GRANT raises 42501, a column-level denial raises 42501, a dead
--     `auth.uid()` raises 42501, and SOME OTHER guard trigger raises 42501.
--     This repository refuses writes with guard triggers in 0223, 0305, 0326
--     and 0331, so adding one to any of these five tables for an unrelated rule
--     would leave these checks passing with 0310's manager guard dropped;
--   * checks 4-8 assert ZERO ROWS and credit a USING clause — but a row this
--     session simply cannot SEE reports zero rows just as readily. All five
--     tables read through `is_family_member`, so one narrowed SELECT policy
--     would silence all five at once.
--
-- The control's UPDATEs name the SAME COLUMNS the breaches do — label and kind
-- on trip_items, status and pickup_time on rides, status on opportunities,
-- destination and start_date on trips — and that is not decoration. Postgres
-- checks column privileges against the SET list and not against the values, so
-- a `revoke update (pickup_time) on rides from authenticated` sails straight
-- past a control that only touched `status`, and then kills check 5 as a bare
-- "permission denied for table rides": red, but with the attribution thrown
-- away exactly as it was before this control existed.
--
-- Check 1, the member's done-tick, does not cover any of this. It is one UPDATE
-- of one column on one of the five tables, and `is_done` is the single column
-- every guard here deliberately leaves open — a control that exercises only it
-- proves nothing about the columns and verbs that are guarded. Check 10's
-- parent does not cover it either: it proves the guards let SOMEBODY through,
-- not that the CHILD's session could have written anything at all. Every row
-- the child is tested against is inserted before the session switches, which is
-- precisely how the document-vault probe passed for a release while the teen
-- could not INSERT a document at all.
--
-- WHAT IT WOULD CATCH: a revoked or column-scoped GRANT on any of the five
-- tables; an `auth.uid()` that no longer resolves in this harness; a narrowed
-- SELECT policy that hides the seeded rows from the child; and any unrelated
-- guard trigger added later that refuses the child's write before 0310's
-- manager guard is ever consulted. In every one of those cases the eight
-- refusals below still report green today, and this control goes red.
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
  -- The control household: a SECOND family the SAME child MANAGES. New UUID,
  -- checked against every file under docs/audit and supabase/migrations before
  -- it was used — run-probes.sh runs all 65 probes in sequence against ONE
  -- database, and a reused anchor silently rewrites what another probe asserts.
  ctl_fam uuid := '00000000-0000-4000-8000-0000000ce102';
  ctl_ride uuid;
  ctl_renewal uuid;
  ctl_signup uuid;
  ctl_trip uuid;
  ctl_item uuid;
  ctl_spare_item uuid;
  control text[] := '{}';
begin
  delete from public.trip_items where family_id = fam;
  delete from public.trips where family_id = fam;
  delete from public.rides where family_id = fam;
  delete from public.renewals where family_id = fam;
  delete from public.opportunities where family_id = fam;
  delete from public.trip_items where family_id = ctl_fam;
  delete from public.trips where family_id = ctl_fam;
  delete from public.rides where family_id = ctl_fam;
  delete from public.renewals where family_id = ctl_fam;
  delete from public.opportunities where family_id = ctl_fam;

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

  -- ── the negative control's own household ─────────────────────────────────
  -- ctl_fam is a family the CHILD created, so `can_manage_family(ctl_fam)`
  -- answers YES for the very user `can_manage_family(fam)` answers NO for —
  -- one predicate, one actor, both answers. on_family_created files the creator
  -- as a 'parent' already; upsert rather than assume, because a seed whose roles
  -- are wrong would fail the control for a reason that is not the control's.
  insert into public.families (id, name, created_by)
    values (ctl_fam, 'Child''s Own House', child_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (ctl_fam, child_uid, 'Child (a manager here)', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;

  -- One row per write the child is refused below, in the family they manage.
  insert into public.rides (family_id, title, ride_date, status, created_by)
    values (ctl_fam, 'Control practice', current_date, 'planned', child_uid) returning id into ctl_ride;
  insert into public.renewals (family_id, title, expires_at, status, created_by)
    values (ctl_fam, 'Control passport', current_date + 30, 'active', child_uid) returning id into ctl_renewal;
  insert into public.opportunities (family_id, title, status, created_by)
    values (ctl_fam, 'Control camp', 'interested', child_uid) returning id into ctl_signup;
  insert into public.trips (family_id, name, status, created_by)
    values (ctl_fam, 'Control lake house', 'planning', child_uid) returning id into ctl_trip;
  insert into public.trip_items (family_id, trip_id, kind, label, is_done, created_by)
    values (ctl_fam, ctl_trip, 'packing', 'Control sunscreen', false, child_uid) returning id into ctl_item;
  -- A second item, so the control's DELETE leg cannot destroy the row its
  -- content-UPDATE leg depends on.
  insert into public.trip_items (family_id, trip_id, kind, label, is_done, created_by)
    values (ctl_fam, ctl_trip, 'packing', 'Control towels', false, child_uid) returning id into ctl_spare_item;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- ── 0. NEGATIVE CONTROL: the same child, the same guards, the other answer ─
  -- Seven statements, one for each write refused in checks 2-8, run by THIS
  -- session in the family this child DOES manage, naming the SAME columns. All
  -- seven must land. If any does not, this session never had the access the
  -- refusals below are supposed to be measuring, and the probe reports the
  -- boundary as UNPROVEN rather than as holding. See the header for what each
  -- leg catches and which mechanism each is attributed to.
  --
  -- It runs FIRST, before the refusals it gives meaning to, because a control
  -- read after the fact is a control nobody looked at.
  if not public.can_manage_family(ctl_fam) then
    raise exception
      'ui-only-manager-gate UNPROVEN (the control''s own seed did not hold): this child is not a manager of the control family %, so the control cannot ask 0310''s guards the same question with the answer the other way',
      ctl_fam;
  end if;

  -- 0a. trip_items CONTENT update — the mirror of check 2, and the leg that
  --     covers the TRIGGER rather than a policy: `trg_trip_item_content_guard`
  --     lets a manager through the very branch it raises 42501 on below. Same
  --     columns as check 2: label and kind.
  begin
    update public.trip_items set label = 'Control fireworks', kind = 'todo' where id = ctl_item;
    get diagnostics n = row_count;
    if n <> 1 then
      control := array_append(control, format('CONTROL FAILED: this child could not rewrite a trip item in the family they DO manage (rows: %s) — check 2 then measures a row this session cannot write, not the content trigger', n));
    end if;
  exception when others then
    control := array_append(control, format('CONTROL FAILED: this child''s trip-item content UPDATE in the family they DO manage raised %s: %s — so check 2''s insufficient_privilege is that, not trg_trip_item_content_guard', sqlstate, sqlerrm));
  end;

  -- 0b. trip_items INSERT — the mirror of check 3, same column list.
  begin
    insert into public.trip_items (family_id, trip_id, kind, label, created_by)
      values (ctl_fam, ctl_trip, 'packing', 'Control slingshot', child_uid);
    get diagnostics n = row_count;
    if n <> 1 then
      control := array_append(control, format('CONTROL FAILED: this child could not add a trip item in the family they DO manage (rows: %s)', n));
    end if;
  exception when others then
    control := array_append(control, format('CONTROL FAILED: this child''s trip-item INSERT in the family they DO manage raised %s: %s — so check 3''s 42501 is a GRANT, a column denial, a dead auth.uid() or some other trigger, not trip_items_manager_insert_guard', sqlstate, sqlerrm));
  end;

  -- 0c. trip_items DELETE — the mirror of check 4.
  begin
    delete from public.trip_items where id = ctl_spare_item;
    get diagnostics n = row_count;
    if n <> 1 then
      control := array_append(control, format('CONTROL FAILED: this child could not delete a trip item in the family they DO manage (rows: %s), so check 4''s zero rows prove nothing — an unreadable row reports zero too', n));
    end if;
  exception when others then
    control := array_append(control, format('CONTROL FAILED: this child''s trip-item DELETE in the family they DO manage raised %s: %s', sqlstate, sqlerrm));
  end;

  -- 0d. rides UPDATE — the mirror of check 5, and BOTH its columns: a
  --     column-scoped revoke on pickup_time is invisible to a status-only leg.
  begin
    update public.rides set status = 'cancelled', pickup_time = '23:00' where id = ctl_ride;
    get diagnostics n = row_count;
    if n <> 1 then
      control := array_append(control, format('CONTROL FAILED: this child could not reschedule and cancel a ride in the family they DO manage (rows: %s), so check 5''s zero rows prove nothing', n));
    end if;
  exception when others then
    control := array_append(control, format('CONTROL FAILED: this child''s ride UPDATE in the family they DO manage raised %s: %s — check 5 is measuring that, not rides_manager_update_guard', sqlstate, sqlerrm));
  end;

  -- 0e. renewals DELETE — the mirror of check 6.
  begin
    delete from public.renewals where id = ctl_renewal;
    get diagnostics n = row_count;
    if n <> 1 then
      control := array_append(control, format('CONTROL FAILED: this child could not delete a renewal reminder in the family they DO manage (rows: %s), so check 6''s zero rows prove nothing', n));
    end if;
  exception when others then
    control := array_append(control, format('CONTROL FAILED: this child''s renewal DELETE in the family they DO manage raised %s: %s', sqlstate, sqlerrm));
  end;

  -- 0f. opportunities UPDATE — the mirror of check 7, same column.
  begin
    update public.opportunities set status = 'registered' where id = ctl_signup;
    get diagnostics n = row_count;
    if n <> 1 then
      control := array_append(control, format('CONTROL FAILED: this child could not register a signup in the family they DO manage (rows: %s), so check 7''s zero rows prove nothing', n));
    end if;
  exception when others then
    control := array_append(control, format('CONTROL FAILED: this child''s opportunity UPDATE in the family they DO manage raised %s: %s', sqlstate, sqlerrm));
  end;

  -- 0g. trips UPDATE — the mirror of check 8, and both its columns.
  begin
    update public.trips set destination = 'Vegas', start_date = current_date where id = ctl_trip;
    get diagnostics n = row_count;
    if n <> 1 then
      control := array_append(control, format('CONTROL FAILED: this child could not change a trip in the family they DO manage (rows: %s), so check 8''s zero rows prove nothing', n));
    end if;
  exception when others then
    control := array_append(control, format('CONTROL FAILED: this child''s trip UPDATE in the family they DO manage raised %s: %s', sqlstate, sqlerrm));
  end;

  -- The control's rows do not outlive the control. Two of the seven legs delete
  -- their own row; the other five do not, and a stray row in a second family is
  -- exactly the quiet contamination that turns one unattributed check into one
  -- false failure in a probe that is not this one — run-probes.sh runs all 65
  -- against ONE database, in sequence, and the rows a probe commits are still
  -- there when the next one starts. Unconditional, and before the raise below.
  reset role;
  delete from public.trip_items where family_id = ctl_fam;
  delete from public.trips where family_id = ctl_fam;
  delete from public.rides where family_id = ctl_fam;
  delete from public.renewals where family_id = ctl_fam;
  delete from public.opportunities where family_id = ctl_fam;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- A failed control makes every refusal below unreadable, so say WHY the probe
  -- cannot speak, here, while the reason is still in hand. The boundary is not
  -- reported as holding and it is not reported as broken: it is reported as
  -- UNPROVEN, and the build is red either way.
  if array_length(control, 1) is not null then
    raise exception 'ui-only-manager-gate UNPROVEN (the control this probe rests on did not hold): %', array_to_string(control, ' | ');
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
  raise notice 'ui-only-manager-gate: OK — the same child CAN run all seven writes in the family they manage (control), a member may tick a packing item, and in the family they do not manage a child may not run these modules';
end
$probe$;
