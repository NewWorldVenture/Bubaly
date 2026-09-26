-- A screen-time log is not the child's to erase (0340).
--
-- As the CHILD: deleting their 5-hour entry, or editing it down to 20
-- minutes, must be refused. Controls: the child still logs time; the PARENT
-- deletes an entry.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ee71';
  uPar uuid := '00000000-0000-4000-8000-00000000ee7a';
  uKid uuid := '00000000-0000-4000-8000-00000000ee7b';
  mKid uuid; big uuid; mine uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'stlog-parent@example.com'), (uKid, 'stlog-kid@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Screen log family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uKid, 'Kid', 'child', true) returning id into mKid;
  insert into public.screen_time_entries (family_id, member_id, minutes) values (fam, mKid, 300) returning id into big;

  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.screen_time_entries set minutes = 20 where id = big;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child edited down their screen time (rows: %)', n; failures := failures + 1; end if;
  delete from public.screen_time_entries where id = big;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child deleted their screen-time entry (rows: %)', n; failures := failures + 1; end if;
  insert into public.screen_time_entries (family_id, member_id, minutes) values (fam, mKid, 30) returning id into mine;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a child could not log time (rows: %)', n; failures := failures + 1; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.screen_time_entries where id = mine;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not delete an entry (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uKid);

  if failures > 0 then
    raise exception 'screen-time-log-check: % failure(s)', failures;
  end if;
end
$probe$;
