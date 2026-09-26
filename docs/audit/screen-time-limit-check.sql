-- Can a child switch off their own screen-time limit?
--
-- screen_time_limits was member FOR ALL, and the module showed "set daily
-- limit" to everyone. 0325: members read, managers write. As the CHILD: raising
-- or deleting their limit matches zero rows, creating one is refused; they can
-- still read it (control). As the PARENT: setting it succeeds (control).
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ed81';
  uPar uuid := '00000000-0000-4000-8000-00000000ed8a';
  uKid uuid := '00000000-0000-4000-8000-00000000ed8b';
  mKid uuid; lim uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'screen-parent@example.com'), (uKid, 'screen-kid@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Screen family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uKid, 'Kid', 'child', true) returning id into mKid;
  insert into public.screen_time_limits (family_id, member_id, daily_minutes) values (fam, mKid, 90) returning id into lim;

  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.screen_time_limits where id = lim;
  if n <> 1 then raise warning 'CONTROL FAILED: the child cannot see their limit (%)', n; failures := failures + 1; end if;
  update public.screen_time_limits set daily_minutes = 1440 where id = lim;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child raised their own screen-time limit (rows: %)', n; failures := failures + 1; end if;
  delete from public.screen_time_limits where id = lim;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child deleted their screen-time limit (rows: %)', n; failures := failures + 1; end if;
  reset role;

  -- Creating one needs a member without a limit (unique per member).
  delete from public.screen_time_limits where id = lim;
  set local role authenticated;
  begin
    insert into public.screen_time_limits (family_id, member_id, daily_minutes) values (fam, mKid, 1440);
    raise warning 'BREACH: a child set their own screen-time limit'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.screen_time_limits (family_id, member_id, daily_minutes) values (fam, mKid, 60);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not set a limit (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uKid);

  if failures > 0 then
    raise exception 'screen-time-limit-check: % failure(s)', failures;
  end if;
end
$probe$;
