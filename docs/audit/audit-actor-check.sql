-- A member's audit entry names the member (0334).
--
-- As the CHILD: appending an audit_logs or wallet_audit_logs entry that names
-- the parent (or no one) as the actor must be refused. Control: the child's
-- own entries (as the application writes them) still land.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ee11';
  uPar uuid := '00000000-0000-4000-8000-00000000ee1a';
  uKid uuid := '00000000-0000-4000-8000-00000000ee1b';
  failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'actor-parent@example.com'), (uKid, 'actor-kid@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Actor family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uKid, 'Kid', 'child', true);

  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, detail)
      values (fam, uPar, 'transfer_approved', 'Parent approved $200 to Kid');
    raise warning 'BREACH: a child wrote a wallet audit entry as the parent'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource) values (fam, uPar, 'update', 'screen_time_limits');
    raise warning 'BREACH: a child wrote an audit entry as the parent'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource) values (fam, null, 'delete', 'chores');
    raise warning 'BREACH: a child wrote an unattributed audit entry'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  insert into public.audit_logs (family_id, actor_id, action, resource) values (fam, uKid, 'update', 'profile');
  insert into public.wallet_audit_logs (family_id, actor_user_id, action) values (fam, uKid, 'goal_created');
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uKid);

  if failures > 0 then
    raise exception 'audit-actor-check: % failure(s)', failures;
  end if;
end
$probe$;
