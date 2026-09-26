-- Can a family member rewrite or erase an audit trail?
--
-- social_audit_logs, vacation_audit_logs and sync_change_logs let any member
-- UPDATE and DELETE. 0321 makes them append-only for members: SELECT and INSERT
-- stay (the app writes some trails from members' own sessions), UPDATE and
-- DELETE go. 0330 then drops member INSERT on social_audit_logs, whose only
-- writer is the social_write_audit trigger. Judged on row counts: a refused UPDATE/DELETE raises nothing.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam   uuid := '00000000-0000-4000-8000-00000000ed41';
  uPar  uuid := '00000000-0000-4000-8000-00000000ed4a';
  uTeen uuid := '00000000-0000-4000-8000-00000000ed4b';
  socialRow uuid; vacationRow uuid; changeRow uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'trail-parent@example.com'), (uTeen, 'trail-teen@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Trail family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uTeen, 'Teen', 'teen', true);

  insert into public.social_audit_logs (family_id, action) values (fam, 'access.role_changed') returning id into socialRow;
  insert into public.vacation_audit_logs (family_id, table_name, action) values (fam, 'vacations', 'delete') returning id into vacationRow;
  insert into public.sync_change_logs (family_id, item_type, operation) values (fam, 'event', 'delete') returning id into changeRow;

  perform set_config('request.jwt.claim.sub', uTeen::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uTeen, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- Controls: the trail is readable, and still appendable.
  select count(*) into n from public.social_audit_logs where family_id = fam;
  if n <> 1 then raise warning 'CONTROL FAILED: the teen cannot read social_audit_logs (%)', n; failures := failures + 1; end if;
  -- 0330: social_audit_logs is written by the SECURITY DEFINER social_write_audit
  -- trigger, never by a member directly, so a member cannot forge an entry.
  begin
    insert into public.social_audit_logs (family_id, action) values (fam, 'teen.appended');
    raise warning 'BREACH: a teen forged a social_audit_logs entry'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  -- The finding.
  update public.social_audit_logs set action = 'nothing happened' where id = socialRow;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen rewrote social_audit_logs (rows: %)', n; failures := failures + 1; end if;
  delete from public.social_audit_logs where id = socialRow;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen erased social_audit_logs (rows: %)', n; failures := failures + 1; end if;

  update public.vacation_audit_logs set action = 'nothing happened' where id = vacationRow;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen rewrote vacation_audit_logs (rows: %)', n; failures := failures + 1; end if;
  delete from public.vacation_audit_logs where id = vacationRow;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen erased vacation_audit_logs (rows: %)', n; failures := failures + 1; end if;

  update public.sync_change_logs set operation = 'nothing happened' where id = changeRow;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen rewrote sync_change_logs (rows: %)', n; failures := failures + 1; end if;
  delete from public.sync_change_logs where id = changeRow;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen erased sync_change_logs (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uTeen);

  if failures > 0 then
    raise exception 'audit-trail-append-only-check: % failure(s)', failures;
  end if;
end
$probe$;
