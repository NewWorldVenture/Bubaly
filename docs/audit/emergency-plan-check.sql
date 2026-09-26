-- The family's emergency contacts and plans are a manager's to write (0337).
--
-- As the CHILD: approving a new contact for pickup, changing a contact's
-- phone, and rewriting the meeting place must be refused; the child can still
-- read both (control). As the PARENT: updating a contact succeeds (control).
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ee41';
  uPar uuid := '00000000-0000-4000-8000-00000000ee4a';
  uKid uuid := '00000000-0000-4000-8000-00000000ee4b';
  contact uuid; plan uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'sos-parent@example.com'), (uKid, 'sos-kid@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Emergency family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uKid, 'Kid', 'child', true);
  insert into public.family_emergency_contacts (family_id, name, phone, can_pickup) values (fam, 'Grandma', '+15550100', true) returning id into contact;
  insert into public.family_emergency_plans (family_id, title, safe_location) values (fam, 'Fire', 'Mailbox at the corner') returning id into plan;

  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.family_emergency_contacts where family_id = fam;
  if n <> 1 then raise warning 'CONTROL FAILED: the child cannot read the emergency contacts (%)', n; failures := failures + 1; end if;
  begin
    insert into public.family_emergency_contacts (family_id, name, phone, can_pickup) values (fam, 'Stranger', '+15559999', true);
    raise warning 'BREACH: a child approved a new contact for pickup'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  update public.family_emergency_contacts set phone = '+15559999' where id = contact;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child changed an emergency contact''s phone (rows: %)', n; failures := failures + 1; end if;
  update public.family_emergency_plans set safe_location = 'Somewhere else' where id = plan;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child rewrote the emergency meeting place (rows: %)', n; failures := failures + 1; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.family_emergency_contacts set alt_phone = '+15550101' where id = contact;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not update a contact (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uKid);

  if failures > 0 then
    raise exception 'emergency-plan-check: % failure(s)', failures;
  end if;
end
$probe$;
