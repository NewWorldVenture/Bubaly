-- AUTHZ-005: can a child change who Guardian trusts and how their calls route?
--
-- Guardian's screening decisions come from four tables. 0215 made routing
-- rules manager-only; 0319 does the same for caller trust (guardian_contacts),
-- member routing profiles (guardian_member_profiles) and the learning queue
-- (guardian_suggestions), and drops a member INSERT on guardian_communications
-- that only the service role ever needed.
--
-- As a TEEN: every write must be refused. INSERT refusals raise; UPDATE and
-- DELETE refusals raise nothing and match zero rows, so they are judged on row
-- counts. As a PARENT: the same writes succeed (control). The teen can still
-- READ all four (control), as 0215 intended.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam   uuid := '00000000-0000-4000-8000-00000000ef01';
  uPar  uuid := '00000000-0000-4000-8000-00000000ef0a';
  uTeen uuid := '00000000-0000-4000-8000-00000000ef0b';
  mTeen uuid; contact uuid; profile uuid; suggestion uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'guardian-parent@example.com'), (uTeen, 'guardian-teen@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Guardian family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uTeen, 'Teen', 'teen', true) returning id into mTeen;

  insert into public.guardian_contacts (family_id, trust_level) values (fam, 'unknown') returning id into contact;
  insert into public.guardian_member_profiles (family_id, member_id) values (fam, mTeen) returning id into profile;
  insert into public.guardian_suggestions (family_id, suggestion_type, title, reasoning)
    values (fam, 'update_trust', 'Trust this caller?', 'Called often') returning id into suggestion;

  -- ── as the TEEN ──────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uTeen::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uTeen, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.guardian_contacts where family_id = fam;
  if n <> 1 then raise warning 'CONTROL FAILED: the teen cannot read contacts (%)', n; failures := failures + 1; end if;

  update public.guardian_contacts set trust_level = 'immediate_family' where id = contact;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen raised a caller''s trust level (rows: %)', n; failures := failures + 1; end if;

  delete from public.guardian_contacts where id = contact;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen deleted a Guardian contact (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.guardian_contacts (family_id, trust_level) values (fam, 'immediate_family');
    raise warning 'BREACH: a teen created a trusted Guardian contact'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  update public.guardian_member_profiles set default_mode_unknown = default_mode_immediate, guardian_phone = '+15550000000' where id = profile;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen rewrote a Guardian routing profile (rows: %)', n; failures := failures + 1; end if;

  update public.guardian_suggestions set title = 'Rewritten', status = status where id = suggestion;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a teen rewrote a Guardian suggestion (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.guardian_communications (family_id, comm_type, direction) values (fam, 'call_inbound', 'inbound');
    raise warning 'BREACH: a teen forged Guardian call history'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ── as the PARENT (control) ──────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.guardian_contacts set trust_level = 'trusted_friend' where id = contact;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not set trust (rows: %)', n; failures := failures + 1; end if;

  update public.guardian_member_profiles set current_context = current_context where id = profile;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not update a profile (rows: %)', n; failures := failures + 1; end if;

  insert into public.guardian_suggestions (family_id, suggestion_type, title, reasoning)
    values (fam, 'update_trust', 'Parent-run scan', 'Manual learning run');

  delete from public.guardian_contacts where id = contact;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not delete a contact (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uTeen);

  if failures > 0 then
    raise exception 'guardian-manager-write-check: % failure(s)', failures;
  end if;
end
$probe$;
