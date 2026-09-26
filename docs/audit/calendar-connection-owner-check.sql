-- Can one family member disconnect, rewrite or forge another's calendar sync?
--
-- sync_accounts and sync_audit_logs shipped with "family member access" FOR
-- ALL. 0320 keeps both readable to the family, makes sync_accounts writable only
-- by the member it belongs to, and makes the audit log read-only to members
-- (every writer is the service role).
--
-- As a TEEN against the PARENT's connection: UPDATE/DELETE match zero rows (a
-- refused write raises nothing), INSERT of a connection for someone else and any
-- audit INSERT are refused. The teen can still READ both (control). As the
-- PARENT on their own row: update and delete succeed (control).
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam   uuid := '00000000-0000-4000-8000-00000000ec01';
  uPar  uuid := '00000000-0000-4000-8000-00000000ec0a';
  uTeen uuid := '00000000-0000-4000-8000-00000000ec0b';
  acct  uuid; logRow uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'sync-parent@example.com'), (uTeen, 'sync-teen@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Sync family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uTeen, 'Teen', 'teen', true);
  insert into public.sync_accounts (family_id, user_id, provider, external_id, display_name)
    values (fam, uPar, 'google', 'parent@gmail.test', 'parent@gmail.test') returning id into acct;
  insert into public.sync_audit_logs (family_id, user_id, action) values (fam, uPar, 'connect') returning id into logRow;

  -- ── as the TEEN ──────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uTeen::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uTeen, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.sync_accounts where family_id = fam;
  if n <> 1 then raise warning 'CONTROL FAILED: the teen cannot see the family''s connections (%)', n; failures := failures + 1; end if;
  select count(*) into n from public.sync_audit_logs where family_id = fam;
  if n <> 1 then raise warning 'CONTROL FAILED: the teen cannot read the sync history (%)', n; failures := failures + 1; end if;

  delete from public.sync_accounts where id = acct;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen disconnected a parent''s calendar (rows: %)', n; failures := failures + 1; end if;

  update public.sync_accounts set display_name = 'hijacked' where id = acct;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen rewrote a parent''s calendar connection (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.sync_accounts (family_id, user_id, provider, external_id) values (fam, uPar, 'google', 'forged@gmail.test');
    raise warning 'BREACH: a teen created a calendar connection in a parent''s name'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.sync_audit_logs (family_id, user_id, action) values (fam, uPar, 'disconnect');
    raise warning 'BREACH: a teen forged a sync audit entry'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  delete from public.sync_audit_logs where id = logRow;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen erased sync history (rows: %)', n; failures := failures + 1; end if;
  reset role;

  -- ── as the PARENT, on their own connection (control) ─────────────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.sync_accounts set display_name = 'Parent calendar' where id = acct;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not update their own connection (rows: %)', n; failures := failures + 1; end if;

  delete from public.sync_accounts where id = acct;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not remove their own connection (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uTeen);

  if failures > 0 then
    raise exception 'calendar-connection-owner-check: % failure(s)', failures;
  end if;
end
$probe$;
