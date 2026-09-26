-- A driving record is not the driver's to erase (0339).
--
-- As the TEEN: deleting their 90 mph trip, or editing its max speed down,
-- must be refused. Controls: the teen still logs a trip; the PARENT deletes one.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ee61';
  uPar uuid := '00000000-0000-4000-8000-00000000ee6a';
  uTeen uuid := '00000000-0000-4000-8000-00000000ee6b';
  mTeen uuid; bad uuid; mine uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'drive-parent@example.com'), (uTeen, 'drive-teen@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Driving family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uTeen, 'Teen', 'teen', true) returning id into mTeen;
  insert into public.driving_trips (family_id, member_id, started_at, distance_miles, max_mph, phone_use_seconds, score)
    values (fam, mTeen, now() - interval '1 day', 12, 90, 240, 31) returning id into bad;

  perform set_config('request.jwt.claim.sub', uTeen::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uTeen, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.driving_trips where id = bad;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen deleted their own 90 mph trip (rows: %)', n; failures := failures + 1; end if;
  update public.driving_trips set max_mph = 55, phone_use_seconds = 0, score = 95 where id = bad;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen rewrote their trip record (rows: %)', n; failures := failures + 1; end if;
  insert into public.driving_trips (family_id, member_id, started_at, distance_miles, max_mph, score)
    values (fam, mTeen, now(), 5, 35, 98) returning id into mine;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a teen could not log a trip (rows: %)', n; failures := failures + 1; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.driving_trips where id = mine;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not delete a trip (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uTeen);

  if failures > 0 then
    raise exception 'driving-record-check: % failure(s)', failures;
  end if;
end
$probe$;
