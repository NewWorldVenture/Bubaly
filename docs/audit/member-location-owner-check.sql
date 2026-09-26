-- Can one member report another member's location or safety?
--
-- member_locations, location_events and safety_check_ins let any member write
-- any member's rows. 0326 scopes writes to "your own member row, or a manager";
-- reads are unchanged (family members).
--
-- As TEEN A against CHILD B: moving B, switching B's sharing off, writing B's
-- arrival, checking B in, and deleting B's "need help" must all be refused
-- (UPDATE/DELETE match zero rows; INSERT raises). Controls: A reports A's own
-- location and check-in; A still reads B's; the PARENT can update B's row.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ed91';
  uPar uuid := '00000000-0000-4000-8000-00000000ed9a';
  uA   uuid := '00000000-0000-4000-8000-00000000ed9b';
  uB   uuid := '00000000-0000-4000-8000-00000000ed9c';
  mA uuid; mB uuid; helpRow uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'loc-parent@example.com'), (uA, 'loc-a@example.com'), (uB, 'loc-b@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Locator family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uA, 'Teen A', 'teen', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uB, 'Child B', 'child', true) returning id into mB;
  insert into public.member_locations (family_id, member_id, latitude, longitude, is_sharing)
    values (fam, mB, 40.0, -75.0, true), (fam, mA, 41.0, -76.0, true);
  insert into public.safety_check_ins (family_id, member_id, status) values (fam, mB, 'need_help') returning id into helpRow;

  -- ── as TEEN A ────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.member_locations where member_id = mB;
  if n <> 1 then raise warning 'CONTROL FAILED: A cannot see B''s location (%)', n; failures := failures + 1; end if;

  update public.member_locations set latitude = 0, longitude = 0 where member_id = mB;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member moved another member''s live location (rows: %)', n; failures := failures + 1; end if;

  update public.member_locations set is_sharing = false where member_id = mB;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member switched off another member''s sharing (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.location_events (family_id, member_id, event_type, place_name) values (fam, mB, 'arrived', 'School');
    raise warning 'BREACH: a member wrote another member''s arrival'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.safety_check_ins (family_id, member_id, status) values (fam, mB, 'safe');
    raise warning 'BREACH: a member checked another member in as safe'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  delete from public.safety_check_ins where id = helpRow;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member deleted another member''s "need help" (rows: %)', n; failures := failures + 1; end if;

  -- Controls: A reports A.
  update public.member_locations set latitude = 41.5 where member_id = mA;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: A could not update A''s own location (rows: %)', n; failures := failures + 1; end if;
  insert into public.location_events (family_id, member_id, event_type, place_name) values (fam, mA, 'arrived', 'Home');
  insert into public.safety_check_ins (family_id, member_id, status) values (fam, mA, 'safe');
  reset role;

  -- ── as the PARENT (control) ───────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.member_locations set is_sharing = true where member_id = mB;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not manage a child''s location row (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB);

  if failures > 0 then
    raise exception 'member-location-owner-check: % failure(s)', failures;
  end if;
end
$probe$;
