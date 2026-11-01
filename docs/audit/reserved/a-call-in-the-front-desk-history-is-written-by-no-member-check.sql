-- ── A call in the front desk's history is written by no member (0521) ──────
--
-- call_logs is the AI Front Desk's frozen history: the application reads it
-- and writes nothing to it. 0092 still lets any active member insert a call and
-- update one (call_logs_insert, call_logs_update). The held 0521 drops both and
-- revokes INSERT and UPDATE from anon and authenticated; the members' read and
-- the managers' delete stay.
--
-- Fixture, Front Desk House: a parent and an adult (managers), a teen, a
-- child, a caregiver and a guest. Written as the table owner: a doctor's
-- voicemail, and a second call for the delete controls.
--
-- What this probe asserts, through PostgREST's role:
--
--   1. none of the six members adds a call to the household's history;
--   2. none of them rewrites the voicemail's transcript, and it reads as
--      written afterwards;
--   3. control: the parent, the teen, the child and the caregiver read the
--      voicemail (the read is unchanged; a guest's is 0520's question);
--   4. control: the child's delete of a call removes nothing, and the
--      parent's removes it (OK 1): the managers' delete is unchanged;
--   5. control: the service role adds a call and rewrites one (OK 1 each);
--   6. wiring: no permissive INSERT, UPDATE or ALL policy for a client role,
--      no INSERT or UPDATE privilege for anon or authenticated; the members'
--      read and call_logs_delete (can_manage_family) with its DELETE privilege
--      are there;
--
-- and, only where 0521 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with 0092's insert put back (its policy and the
--       privilege), the child adds a call (OK 1): the fixture reaches it;
--   M1. MUTATION CONTROL: with 0092's update alone put back, the child
--       rewrites the transcript (OK 1), so 2. catches the update returning
--       without the insert.
--
-- Everything is rolled back.
--
-- HELD with 0521: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/call-history-writes-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0521 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8521-0000000000a1','c0521-parent@example.com'),
  ('00000000-0000-4000-8521-0000000000a2','c0521-adult@example.com'),
  ('00000000-0000-4000-8521-0000000000a3','c0521-teen@example.com'),
  ('00000000-0000-4000-8521-0000000000a4','c0521-child@example.com'),
  ('00000000-0000-4000-8521-0000000000a5','c0521-caregiver@example.com'),
  ('00000000-0000-4000-8521-0000000000a6','c0521-guest@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8521-0000000000f1','Front Desk House','00000000-0000-4000-8521-0000000000a1');
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8521-0000000000a1';
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8521-0000000000f1','00000000-0000-4000-8521-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8521-0000000000f1','00000000-0000-4000-8521-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8521-0000000000f1','00000000-0000-4000-8521-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8521-0000000000f1','00000000-0000-4000-8521-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8521-0000000000f1','00000000-0000-4000-8521-0000000000a6','Guest','guest',true);
insert into public.call_logs (id, family_id, caller_name, status, transcript, voicemail_url, ai_summary) values
  ('00000000-0000-4000-8521-0000000000e1','00000000-0000-4000-8521-0000000000f1','Dr. Lee','voicemail',
   'Your results are in; please call the clinic.','https://example.test/voicemail/e1.mp3','The clinic has results'),
  ('00000000-0000-4000-8521-0000000000e2','00000000-0000-4000-8521-0000000000f1','Unknown','missed',null,null,null);

-- One statement as one caller, and exactly what happened.
create or replace function pg_temp.c0521_as(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then json_build_object('role', p_role)
         else json_build_object('sub', p_uid, 'role', p_role) end::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  return got;
end
$fn$;

do $$
declare
  child constant text := '00000000-0000-4000-8521-0000000000a4';
  plant constant text := 'insert into public.call_logs (family_id, caller_name, status, transcript) values (''00000000-0000-4000-8521-0000000000f1'', ''Dr. Lee'', ''voicemail'', ''No need to call back.'')';
  rewrite constant text := 'update public.call_logs set transcript = ''No need to call back.'', ai_summary = ''Nothing to do'' where id = ''00000000-0000-4000-8521-0000000000e1''';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  got text;
  x record;
begin
  installed := not exists (select 1 from pg_policies p
                            where p.schemaname = 'public' and p.tablename = 'call_logs' and p.policyname in ('call_logs_insert', 'call_logs_update'))
               and not has_table_privilege('authenticated', 'public.call_logs', 'insert');

  for x in select * from (values ('parent', '00000000-0000-4000-8521-0000000000a1'), ('adult', '00000000-0000-4000-8521-0000000000a2'),
                                 ('teen', '00000000-0000-4000-8521-0000000000a3'), ('child', '00000000-0000-4000-8521-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8521-0000000000a5'), ('guest', '00000000-0000-4000-8521-0000000000a6')) as v(who, uid) loop
    -- 1. No member adds a call.
    got := pg_temp.c0521_as('authenticated', x.uid, plant);
    if got not like '42501:%' and got <> 'OK 0' then
      failures := array_append(failures, format('the %s added a call to the household''s history (%s)', x.who, got));
    end if;
    -- 2. No member rewrites one.
    got := pg_temp.c0521_as('authenticated', x.uid, rewrite);
    if got not like '42501:%' and got <> 'OK 0' then
      failures := array_append(failures, format('the %s rewrote the voicemail''s transcript (%s)', x.who, got));
    end if;
  end loop;
  -- 2 (continued). The voicemail reads as it was written.
  if (select transcript from public.call_logs where id = '00000000-0000-4000-8521-0000000000e1') <> 'Your results are in; please call the clinic.' then
    failures := array_append(failures, 'the voicemail''s transcript no longer reads as the call was filed');
  end if;
  -- Rows a member planted are taken out again, so the controls below count only the fixture.
  delete from public.call_logs where family_id = '00000000-0000-4000-8521-0000000000f1'
     and id not in ('00000000-0000-4000-8521-0000000000e1', '00000000-0000-4000-8521-0000000000e2');
  update public.call_logs set transcript = 'Your results are in; please call the clinic.', ai_summary = 'The clinic has results'
   where id = '00000000-0000-4000-8521-0000000000e1';

  -- 3. Control: the read is unchanged.
  bad := '{}';
  for x in select * from (values ('parent', '00000000-0000-4000-8521-0000000000a1'), ('teen', '00000000-0000-4000-8521-0000000000a3'),
                                 ('child', '00000000-0000-4000-8521-0000000000a4'), ('caregiver', '00000000-0000-4000-8521-0000000000a5')) as v(who, uid) loop
    got := pg_temp.c0521_as('authenticated', x.uid, 'select 1 from public.call_logs where id = ''00000000-0000-4000-8521-0000000000e1''');
    if got <> 'OK 1' then
      bad := array_append(bad, format('%s (%s)', x.who, got));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('CONTROL: a member no longer reads the voicemail: %s', array_to_string(bad, ', ')));
  end if;

  -- 4. Control: the managers' delete is unchanged.
  got := pg_temp.c0521_as('authenticated', child, 'delete from public.call_logs where id = ''00000000-0000-4000-8521-0000000000e2''');
  if got not in ('OK 0') and got not like '42501:%' then
    failures := array_append(failures, format('CONTROL: the child''s delete of a call was not refused (%s)', got));
  end if;
  got := pg_temp.c0521_as('authenticated', '00000000-0000-4000-8521-0000000000a1', 'delete from public.call_logs where id = ''00000000-0000-4000-8521-0000000000e2''');
  if got <> 'OK 1' then
    failures := array_append(failures, format('CONTROL: the parent''s delete of a call did not remove it (%s)', got));
  end if;

  -- 5. Control: the service role writes.
  got := pg_temp.c0521_as('service_role', null, plant);
  if got <> 'OK 1' then
    failures := array_append(failures, format('CONTROL: the service role did not add a call (%s)', got));
  end if;
  got := pg_temp.c0521_as('service_role', null, rewrite);
  if got <> 'OK 1' then
    failures := array_append(failures, format('CONTROL: the service role did not rewrite a call (%s)', got));
  end if;

  -- 6. Wiring.
  bad := '{}';
  if exists (select 1 from pg_policy p
              where p.polrelid = 'public.call_logs'::regclass and p.polpermissive and p.polcmd in ('*', 'a', 'w')
                and (p.polroles = array[0::oid]
                     or p.polroles && array[(select oid from pg_roles where rolname = 'authenticated'),
                                            (select oid from pg_roles where rolname = 'anon')])) then
    bad := array_append(bad, 'a permissive insert or update policy for a client role is there');
  end if;
  if has_table_privilege('authenticated', 'public.call_logs', 'insert') or has_table_privilege('authenticated', 'public.call_logs', 'update')
     or has_table_privilege('anon', 'public.call_logs', 'insert') or has_table_privilege('anon', 'public.call_logs', 'update') then
    bad := array_append(bad, 'a client role holds INSERT or UPDATE');
  end if;
  if not exists (select 1 from pg_policy p where p.polrelid = 'public.call_logs'::regclass and p.polpermissive and p.polcmd = 'r')
     or not has_table_privilege('authenticated', 'public.call_logs', 'select') then
    bad := array_append(bad, 'the members'' read is gone');
  end if;
  if not exists (select 1 from pg_policy p
                  where p.polrelid = 'public.call_logs'::regclass and p.polname = 'call_logs_delete' and p.polcmd = 'd'
                    and pg_get_expr(p.polqual, p.polrelid) = 'can_manage_family(family_id)')
     or not has_table_privilege('authenticated', 'public.call_logs', 'delete') then
    bad := array_append(bad, 'the managers'' delete is not what it was');
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('call_logs'' writes are not 0521''s: %s', array_to_string(bad, ' | ')));
  end if;

  if installed then
    -- N1. 0092's insert put back.
    begin
      grant insert on public.call_logs to authenticated;
      create policy "call_logs_insert" on public.call_logs for insert with check (
        exists (select 1 from public.family_members where family_id = call_logs.family_id and user_id = auth.uid() and is_active));
      got := pg_temp.c0521_as('authenticated', child, plant);
      if got <> 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with 0092''s insert put back the child still did not add a call (%s), so this fixture cannot see the defect', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. 0092's update alone put back.
    begin
      grant update on public.call_logs to authenticated;
      create policy "call_logs_update" on public.call_logs for update using (
        exists (select 1 from public.family_members where family_id = call_logs.family_id and user_id = auth.uid() and is_active));
      got := pg_temp.c0521_as('authenticated', child, rewrite);
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with 0092''s update put back the child still did not rewrite the transcript (%s), so 2. cannot catch the update returning', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a member writes the front desk''s call history:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-call-in-the-front-desk-history-is-written-by-no-member: OK (none of the parent, the adult, the teen, the child, the caregiver and the guest added a call or rewrote the voicemail''s transcript, which reads as filed; the parent, the teen, the child and the caregiver still read it; the child''s delete removed nothing and the parent''s removed the call (OK 1); the service role added and rewrote a call (OK 1 each); no permissive insert or update policy and no INSERT or UPDATE privilege for a client role, the members'' read and the managers'' delete in place; negative control: with 0092''s insert put back the child adds a call; mutation control: with 0092''s update alone put back the child rewrites the transcript)';
end $$;

rollback;
