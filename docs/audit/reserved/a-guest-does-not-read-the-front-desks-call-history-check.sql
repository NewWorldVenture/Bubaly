-- ── A guest does not read the front desk's call history or the Hub (0520) ───
--
-- The owner's decision on ROLE-SCOPE-001 (held 0509) withholds the household
-- inbox from a guest, on the three pages that show it. 0509 guards the
-- Contact Center's table; the held 0520 guards the other two:
--
--   call_logs              the AI Front Desk's call history
--   family_communications  the Communications Hub on /dashboard/inbox
--
-- each with 0509's "A guest does not read <table>", RESTRICTIVE SELECT,
-- USING not is_family_guest(family_id).
--
-- Fixture, Front Desk House: a parent and an adult (managers), a teen, a
-- child, a caregiver, a guest (who is the parent of a household of their own),
-- and an adult since removed (is_active false); a stranger in another
-- household. Written as the table owner: one call (a doctor's voicemail) and
-- one Hub message in Front Desk House, and one of each in the guest's own
-- household.
--
-- What this probe asserts, through PostgREST's role:
--
--   1. the guest reads neither Front Desk House row;
--   2. control: the parent, the adult, the teen, the child and the caregiver
--      each read both (0520 narrows a guest only);
--   3. control: the guest reads both rows of the household they are a parent
--      of (the guard is per family);
--   4. the removed adult and the stranger read neither;
--   5. control: the service role, carrying the guest's user id and without
--      one, reads both;
--   6. wiring: each table carries 0520's guard by name, restrictive, for
--      SELECT, to authenticated, USING exactly not is_family_guest(family_id),
--      and no other restrictive read; is_family_guest is SECURITY DEFINER with
--      a pinned search_path and not executable by PUBLIC or anon;
--
-- and, only where 0520 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with both guards dropped, the guest reads both Front
--       Desk House rows: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with each guard made PERMISSIVE (the same
--       predicate, ORed with the members' read instead of ANDed), the guest
--       reads both again, so 1. is what catches the guard losing its kind.
--
-- Everything is rolled back.
--
-- HELD with 0520: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/front-desk-guest-runtime.yml runs it there to show the
-- failure, applies the held 0509 (0520 needs its is_family_guest) and shows
-- the failure again, then applies 0520 and requires a pass. It moves back to
-- docs/audit/ when 0520 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8520-0000000000a1','c0520-parent@example.com'),
  ('00000000-0000-4000-8520-0000000000a2','c0520-adult@example.com'),
  ('00000000-0000-4000-8520-0000000000a3','c0520-teen@example.com'),
  ('00000000-0000-4000-8520-0000000000a4','c0520-child@example.com'),
  ('00000000-0000-4000-8520-0000000000a5','c0520-caregiver@example.com'),
  ('00000000-0000-4000-8520-0000000000a6','c0520-guest@example.com'),
  ('00000000-0000-4000-8520-0000000000a8','c0520-gone@example.com'),
  ('00000000-0000-4000-8520-0000000000a9','c0520-stranger@example.com')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8520-0000000000f1','Front Desk House','00000000-0000-4000-8520-0000000000a1'),
  ('00000000-0000-4000-8520-0000000000f2','Guest''s Own House','00000000-0000-4000-8520-0000000000a6'),
  ('00000000-0000-4000-8520-0000000000f3','Next Door','00000000-0000-4000-8520-0000000000a9');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8520-0000000000a1','00000000-0000-4000-8520-0000000000a6','00000000-0000-4000-8520-0000000000a9');
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8520-0000000000f1','00000000-0000-4000-8520-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8520-0000000000f1','00000000-0000-4000-8520-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8520-0000000000f1','00000000-0000-4000-8520-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8520-0000000000f1','00000000-0000-4000-8520-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8520-0000000000f1','00000000-0000-4000-8520-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8520-0000000000f1','00000000-0000-4000-8520-0000000000a8','Adult (removed)','adult',false);

insert into public.call_logs (id, family_id, caller_name, status, transcript, voicemail_url, ai_summary) values
  ('00000000-0000-4000-8520-0000000000e1','00000000-0000-4000-8520-0000000000f1','Dr. Lee','voicemail',
   'Your results are in; please call the clinic.','https://example.test/voicemail/e1.mp3','The clinic has results'),
  ('00000000-0000-4000-8520-0000000000e2','00000000-0000-4000-8520-0000000000f2','School office','answered',
   'Pickup is at noon on Friday.',null,'Early pickup Friday');
insert into public.family_communications (id, family_id, channel, direction, subject, body, category) values
  ('00000000-0000-4000-8520-0000000000e3','00000000-0000-4000-8520-0000000000f1','email','inbound',
   'Hearing moved','The hearing moved to Friday at nine.','legal'),
  ('00000000-0000-4000-8520-0000000000e4','00000000-0000-4000-8520-0000000000f2','note','inbound',
   'Recital','The recital is on the twelfth.','school');

-- How many of one family's rows in one table one caller reads; null if the
-- read itself was refused.
create or replace function pg_temp.c0520_seen(p_role text, p_uid text, t text, fam uuid) returns bigint
language plpgsql as $fn$
declare n bigint;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then json_build_object('role', p_role)
         else json_build_object('sub', p_uid, 'role', p_role) end::text, true);
  begin
    execute format('select count(*) from public.%I where family_id = $1', t) into n using fam;
  exception when others then
    n := null;
  end;
  perform set_config('role', 'postgres', true);
  return n;
end
$fn$;

do $$
declare
  f1 constant uuid := '00000000-0000-4000-8520-0000000000f1';
  f2 constant uuid := '00000000-0000-4000-8520-0000000000f2';
  guest constant text := '00000000-0000-4000-8520-0000000000a6';
  tables constant text[] := array['call_logs', 'family_communications'];
  what constant text[] := array['call history', 'Communications Hub'];
  guard constant text := '(NOT is_family_guest(family_id))';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  t text;
  i int;
  n bigint;
  x record;
begin
  installed := (select count(*) from pg_policies p
                 where p.schemaname = 'public' and p.tablename = any (tables)
                   and p.policyname = 'A guest does not read ' || p.tablename
                   and p.permissive = 'RESTRICTIVE' and p.cmd = 'SELECT') = 2;

  -- 1. The guest reads neither Front Desk House row.
  for i in 1 .. 2 loop
    n := pg_temp.c0520_seen('authenticated', guest, tables[i], f1);
    if n is distinct from 0 then
      failures := array_append(failures, format('the guest reads the household''s %s (%s: %s row(s))', what[i], tables[i], coalesce(n::text, 'refused')));
    end if;
  end loop;

  -- 2. Control: every other member reads both.
  bad := '{}';
  for x in select * from (values ('parent', '00000000-0000-4000-8520-0000000000a1'), ('adult', '00000000-0000-4000-8520-0000000000a2'),
                                 ('teen', '00000000-0000-4000-8520-0000000000a3'), ('child', '00000000-0000-4000-8520-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8520-0000000000a5')) as v(who, uid) loop
    foreach t in array tables loop
      n := pg_temp.c0520_seen('authenticated', x.uid, t, f1);
      if n is distinct from 1 then
        bad := array_append(bad, format('the %s read %s of %s', x.who, coalesce(n::text, 'refused'), t));
      end if;
    end loop;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('CONTROL: a member who is not a guest lost the household''s rows: %s', array_to_string(bad, ', ')));
  end if;

  -- 3. Control: the guest reads the household they are a parent of.
  foreach t in array tables loop
    n := pg_temp.c0520_seen('authenticated', guest, t, f2);
    if n is distinct from 1 then
      failures := array_append(failures, format('CONTROL: the guest read %s of %s in the household they are a parent of, not 1', coalesce(n::text, 'refused'), t));
    end if;
  end loop;

  -- 4. The removed adult and the stranger read neither.
  for x in select * from (values ('removed adult', '00000000-0000-4000-8520-0000000000a8'), ('stranger', '00000000-0000-4000-8520-0000000000a9')) as v(who, uid) loop
    foreach t in array tables loop
      n := pg_temp.c0520_seen('authenticated', x.uid, t, f1);
      if n is distinct from 0 then
        failures := array_append(failures, format('the %s reads %s of Front Desk House''s %s', x.who, coalesce(n::text, 'refused'), t));
      end if;
    end loop;
  end loop;

  -- 5. Control: the service role, with the guest's user id and without one.
  foreach t in array tables loop
    if pg_temp.c0520_seen('service_role', guest, t, f1) is distinct from 1
       or pg_temp.c0520_seen('service_role', null, t, f1) is distinct from 1 then
      failures := array_append(failures, format('CONTROL: the service role did not read Front Desk House''s %s', t));
    end if;
  end loop;

  -- 6. Wiring.
  bad := '{}';
  foreach t in array tables loop
    if not exists (select 1 from pg_policies p
                    where p.schemaname = 'public' and p.tablename = t and p.policyname = 'A guest does not read ' || t
                      and p.permissive = 'RESTRICTIVE' and p.cmd = 'SELECT' and p.roles::text[] = array['authenticated']
                      and replace(p.qual, 'public.', '') = guard) then
      bad := array_append(bad, format('%s (missing)', t));
    end if;
    if exists (select 1 from pg_policies p
                where p.schemaname = 'public' and p.tablename = t and p.permissive = 'RESTRICTIVE' and p.cmd in ('SELECT', 'ALL')
                  and p.policyname <> 'A guest does not read ' || t) then
      bad := array_append(bad, format('%s (a restrictive read policy other than a guest''s)', t));
    end if;
  end loop;
  if to_regprocedure('public.is_family_guest(uuid)') is null then
    bad := array_append(bad, 'is_family_guest (missing: the held 0509 is not installed)');
  elsif not exists (select 1 from pg_proc p where p.oid = 'public.is_family_guest(uuid)'::regprocedure
                     and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%')
     or has_function_privilege('anon', 'public.is_family_guest(uuid)', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                 where p.oid = 'public.is_family_guest(uuid)'::regprocedure
                   and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    bad := array_append(bad, 'is_family_guest (not SECURITY DEFINER with a pinned search_path, or executable by PUBLIC or anon)');
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('the guest read guard is not 0520''s on %s', array_to_string(bad, ' | ')));
  end if;

  if installed then
    -- N1. Both guards dropped.
    begin
      foreach t in array tables loop
        execute format('drop policy %I on public.%I', 'A guest does not read ' || t, t);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        if pg_temp.c0520_seen('authenticated', guest, t, f1) is distinct from 1 then
          bad := array_append(bad, t);
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guards dropped the guest did not read Front Desk House''s row in %s, so this fixture cannot see the defect', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. Each guard made permissive.
    begin
      foreach t in array tables loop
        execute format('drop policy %I on public.%I', 'A guest does not read ' || t, t);
        execute format('create policy %I on public.%I as permissive for select to authenticated using (not public.is_family_guest(family_id))',
                       'A guest does not read ' || t, t);
      end loop;
      bad := '{}';
      foreach t in array tables loop
        if pg_temp.c0520_seen('authenticated', guest, t, f1) is distinct from 1 then
          bad := array_append(bad, t);
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('MUTATION CONTROL: with the guard made permissive the guest still did not read Front Desk House''s row in %s, so 1. cannot catch the guard losing its kind', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a guest reads the front desk''s call history or the Communications Hub:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-guest-does-not-read-the-front-desks-call-history: OK (the guest read neither the call nor the Hub message of Front Desk House; the parent, the adult, the teen, the child and the caregiver read both; the guest read both rows of the household they are a parent of; the removed adult and a stranger read neither; the service role with and without a user id read both; each table carries 0520''s restrictive guard with its exact predicate and no other restrictive read, is_family_guest SECURITY DEFINER with a pinned search_path and not executable by PUBLIC or anon; negative control: without the guards the guest reads both; mutation control: with the guards made permissive the guest reads both)';
end $$;

rollback;
