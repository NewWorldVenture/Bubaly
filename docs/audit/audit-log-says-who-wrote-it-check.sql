-- ── S-04 The audit trail records who actually appended, not who was claimed ──
--
-- `audit_insert` pinned `family_id` and nothing else, so `actor_id` was free: a
-- child could file a row attributing an action to a parent, and
-- `/family/activity` renders exactly what the row says. The `family_id is null`
-- branch let any authenticated user write rows no RLS reader can see and which
-- `app/(app)/admin/security/page.tsx` renders with the SERVICE client.
--
-- 0260 fixed the same defect on `trust_audit_logs` by dropping member INSERT
-- outright. That is not available here: fourteen callers append on the caller's
-- own client, and `docs/audit/household-trail-check.sql` states the intent —
-- "ANY member may append … while only a parent or adult may read it back". So
-- 0300 pins the shape instead, and this proves the pin without weakening append.
--
--   1. a child can STILL append a row about themselves (append is preserved —
--      a boundary that stops the honest caller is the wrong boundary);
--   2. a child CANNOT append a row naming the parent as actor;
--   3. a child CANNOT append a row with no household at all;
--   4. a parent cannot forge either — this is not a role check, it is identity;
--   5. reads stay manager-only (unchanged by 0300, asserted so a later edit to
--      the insert policy cannot quietly take the read policy with it).
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/audit-log-says-who-wrote-it-check.sql

\set FA '00000000-0000-4000-8000-0000000000d1'
\set UP '00000000-0000-4000-8000-0000000000d2'
\set UK '00000000-0000-4000-8000-0000000000d3'

begin;

insert into auth.users (id, email) values (:'UP','d-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','d-kid@example.com')    on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FA','Trail House',:'UP') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FA',:'UK','Kid','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FA' and user_id = :'UP';

grant select, insert on public.audit_logs to authenticated;

do $$
declare
  n int;
  failures text[] := '{}';
  fam      constant uuid := '00000000-0000-4000-8000-0000000000d1';
  parent_u constant uuid := '00000000-0000-4000-8000-0000000000d2';
  kid_u    constant uuid := '00000000-0000-4000-8000-0000000000d3';
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. Append, as themselves. This has to keep working.
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (fam, kid_u, 'update', 'chores');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child can no longer append a row about THEMSELVES — the trail now has holes where the work is');
  end;

  -- 2. The forgery: the same row, signed with the parent's id.
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource, metadata)
      values (fam, parent_u, 'delete', 'wallet_transactions', '{"note":"written by the child"}'::jsonb);
    failures := array_append(failures, 'a child ATTRIBUTED a wallet deletion to the parent');
  exception when insufficient_privilege then null;
  end;

  -- 3. The platform-feed flood: rows that belong to no household, which no RLS
  --    reader can see and the admin Security page renders with the service client.
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (null, kid_u, 'security.alert', 'platform');
    failures := array_append(failures, 'a child wrote a family_id IS NULL row into the platform security feed');
  exception when insufficient_privilege then null;
  end;

  -- 4. Identity, not role: a parent cannot sign for the child either.
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (fam, kid_u, 'create', 'allowance');
    failures := array_append(failures, 'a PARENT attributed an action to the child — the pin is a role check, not an identity check');
  exception when insufficient_privilege then null;
  end;

  -- The parent's own append still works (the positive control for the fix).
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (fam, parent_u, 'create', 'allowance');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a PARENT could not append a row about themselves');
  end;

  -- 5. Reads stay manager-only.
  select count(*) into n from public.audit_logs where family_id = fam;
  if n = 0 then failures := array_append(failures, 'a PARENT cannot read the trail'); end if;
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  select count(*) into n from public.audit_logs where family_id = fam;
  if n <> 0 then failures := array_append(failures, format('a child READ %s trail row(s); audit_select is supposed to be can_manage_family', n)); end if;

  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception 'audit trail authenticity failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK audit_logs: a member appends only as themselves, no one signs for anyone else, no household-less rows, reads stay manager-only';
end $$;

rollback;
