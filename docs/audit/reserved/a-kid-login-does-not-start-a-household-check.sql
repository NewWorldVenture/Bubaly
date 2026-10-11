-- ── A kid login does not start a household (0507) ───────────────────────────
--
-- families_insert lets a signed-in caller create a family naming itself, and
-- on_family_created files the creator as its parent. 0482 refuses a kid login
-- there (`not is_child_login_account()`: a child_logins row or the synthetic
-- kid domain). The held 0507 makes that test also read the server's
-- app_metadata mark, as 0495's accept_invite does, so a kid login whose
-- address moved off the domain is still refused.
--
-- What this probe asserts, through PostgREST's role, each outcome exact
-- (`OK <rows>` or the SQLSTATE and message):
--
--   1. a kid login on the domain with the mark, one known only by the mark
--      (address moved off the domain, no mapping) and one known only by its
--      address each create a family: refused with 42501 "new row violates
--      row-level security policy for table "families"", and none belongs to a
--      household besides its own family (counted);
--   2. so the stranger's invitation has no household to land in (counted);
--   3. control: an adult creates a family (OK 1) and is filed as its parent,
--      and so does an adult whose own user_metadata claims to be a child (the
--      owner can edit user_metadata, so it is not read);
--   4. control: the service role carrying the kid's user id, and a writer with
--      no session, each create a family (OK 1);
--   5. wiring: is_child_login_account() is SECURITY DEFINER with a pinned
--      search_path, reads the mapping, the domain and the mark, is not
--      executable by PUBLIC or anon, and families_insert asks it;
--
-- and, only where 0507 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with 0482's body put back (no mark), the moved kid
--       login's family lands (OK 1), it is the parent, and it writes the
--       stranger's invitation (OK 1): the fixture reaches the limit 0507
--       closes;
--   M1. MUTATION CONTROL: with families_insert's `not is_child_login_account()`
--       taken off, the kid login on the domain starts a household (OK 1), so
--       1. is what catches a policy that stops asking.
--
-- Not measured here, recorded in the migration: the server's own provisioning
-- (ensureActiveFamily, through the service role) recognises a kid login by its
-- own rule; that is the membership lane's.
--
-- Everything is rolled back.
--
-- HELD with 0507: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/kid-household-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0507 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
  ('00000000-0000-4000-8507-0000000000a1','k0507-parent@example.com','{}','{}'),
  -- The kid login as createChildLoginAction makes it: on the domain, and marked.
  ('00000000-0000-4000-8507-0000000000a3','child.k0507kid@kids.bubaly.app','{"bubaly_kid_login": true}','{}'),
  -- A kid login whose address was moved off the domain: known by the mark only.
  ('00000000-0000-4000-8507-0000000000a4','k0507-moved@example.com','{"bubaly_kid_login": true}','{}'),
  -- A kid login made before the mark existed: known by its address only.
  ('00000000-0000-4000-8507-0000000000a5','child.k0507old@kids.bubaly.app','{}','{}'),
  -- An adult whose own (editable) user_metadata says child.
  ('00000000-0000-4000-8507-0000000000a6','k0507-adult@example.com','{}','{"child": true}'),
  ('00000000-0000-4000-8507-0000000000a9','k0507-stranger@example.com','{}','{}')
  on conflict do nothing;
-- on_family_created files the creator as Real Home's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8507-0000000000f1','Real Home','00000000-0000-4000-8507-0000000000a1');
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8507-0000000000f1','00000000-0000-4000-8507-0000000000a3','Kid','child',true),
  ('00000000-0000-4000-8507-0000000000f1','00000000-0000-4000-8507-0000000000a4','Kid (moved)','child',true),
  ('00000000-0000-4000-8507-0000000000f1','00000000-0000-4000-8507-0000000000a5','Kid (older login)','child',true);

-- One statement as one caller, and exactly what happened. p_role 'service_role'
-- carries the user id in its claims as PostgREST's service client does; a null
-- p_uid is a writer with no session at all.
create or replace function pg_temp.k0507_as(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return got;
end
$fn$;

create or replace function pg_temp.k0507_new_family(p_id text, p_name text, p_by text) returns text
language sql as $fn$
  select format('insert into public.families (id, name, created_by) values (%L, %L, %L)', p_id, p_name, p_by)
$fn$;

do $$
declare
  kid       constant text := '00000000-0000-4000-8507-0000000000a3';
  moved     constant text := '00000000-0000-4000-8507-0000000000a4';
  older     constant text := '00000000-0000-4000-8507-0000000000a5';
  adult     constant text := '00000000-0000-4000-8507-0000000000a6';
  parent    constant text := '00000000-0000-4000-8507-0000000000a1';
  kid_home  constant text := '00000000-0000-4000-8507-0000000000f9';
  refused   constant text := '42501: new row violates row-level security policy for table "families"';
  installed boolean := exists (select 1 from pg_proc f
                                where f.oid = to_regprocedure('public.is_child_login_account()')
                                  and f.prosrc ~ 'bubaly_kid_login');
  failures  text[] := '{}';
  t         record;
  got       text;
  n         int;
begin
  -- 1-2. Each kind of kid login starts a household.
  for t in select * from (values
      (kid,   'a kid login (on the domain, marked)',          '00000000-0000-4000-8507-0000000000f9'),
      (moved, 'a kid login known by its app_metadata mark',    '00000000-0000-4000-8507-0000000000fa'),
      (older, 'a kid login known by its address',              '00000000-0000-4000-8507-0000000000fb')
    ) as v(uid, who, fam) loop
    got := pg_temp.k0507_as('authenticated', t.uid, pg_temp.k0507_new_family(t.fam, 'Kid''s Own House', t.uid));
    if got is distinct from refused then
      failures := array_append(failures, format('%s started a household of its own (%s)', t.who, got));
    end if;
    select count(*) into n from public.family_members
     where user_id = t.uid::uuid and family_id <> '00000000-0000-4000-8507-0000000000f1';
    if n <> 0 then
      failures := array_append(failures, format('%s belongs to %s household(s) besides its own family', t.who, n));
    end if;
  end loop;

  -- 3. The stranger's invitation has no household to land in.
  select count(*) into n from public.families where id = kid_home::uuid;
  if n <> 0 then
    failures := array_append(failures, 'the kid login''s own household exists, so a stranger can be invited into it');
  end if;

  -- 4. Adults still start households, and are filed as their parent.
  for t in select * from (values
      (parent, 'Real Home''s parent',                         '00000000-0000-4000-8507-0000000000e1'),
      (adult,  'an adult whose own user_metadata says child', '00000000-0000-4000-8507-0000000000e2')
    ) as v(uid, who, fam) loop
    got := pg_temp.k0507_as('authenticated', t.uid, pg_temp.k0507_new_family(t.fam, 'Second Home', t.uid));
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s can no longer start a household (%s)', t.who, got));
    end if;
    select count(*) into n from public.family_members
     where family_id = t.fam::uuid and user_id = t.uid::uuid and role = 'parent' and is_active;
    if n <> 1 then
      failures := array_append(failures, format('CONTROL: %s is not the new household''s parent (%s rows)', t.who, n));
    end if;
  end loop;

  -- 5. The server.
  got := pg_temp.k0507_as('service_role', kid, pg_temp.k0507_new_family('00000000-0000-4000-8507-0000000000e3', 'Made by the server', parent));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL (service role, with the kid''s user id): refused (%s)', got));
  end if;
  got := pg_temp.k0507_as('postgres', null, pg_temp.k0507_new_family('00000000-0000-4000-8507-0000000000e4', 'Made by a seed', parent));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL (no session): refused (%s)', got));
  end if;

  -- 5. Wiring.
  if not exists (select 1 from pg_proc f
                  where f.oid = to_regprocedure('public.is_child_login_account()')
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')
                    and f.prosrc ~ 'child_logins'
                    and f.prosrc ~ '@kids\.bubaly\.app'
                    and f.prosrc ~ 'raw_app_meta_data->>''bubaly_kid_login''') then
    failures := array_append(failures, 'is_child_login_account() does not read the kid-login mark the server writes (or is not a pinned SECURITY DEFINER test)');
  elsif has_function_privilege('public', 'public.is_child_login_account()', 'execute')
     or has_function_privilege('anon', 'public.is_child_login_account()', 'execute') then
    failures := array_append(failures, 'PUBLIC or anon may execute is_child_login_account()');
  end if;
  if not exists (select 1 from pg_policies p
                  where p.schemaname = 'public' and p.tablename = 'families'
                    and p.policyname = 'families_insert' and p.cmd = 'INSERT'
                    and p.with_check ~ 'NOT is_child_login_account\(\)') then
    failures := array_append(failures, 'families_insert does not ask is_child_login_account()');
  end if;

  if installed then
    -- N1. 0482's body put back: the mark is no longer read.
    begin
      create or replace function public.is_child_login_account()
      returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $n$
        select auth.uid() is not null and (
          exists (select 1 from public.child_logins c where c.user_id = auth.uid())
          or exists (select 1 from auth.users u where u.id = auth.uid() and lower(u.email) like '%@kids.bubaly.app'))
      $n$;
      got := pg_temp.k0507_as('authenticated', moved, pg_temp.k0507_new_family(kid_home, 'Kid''s Own House', moved));
      if got is distinct from 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with 0482''s test put back the moved kid login''s household did not land (%s)', got));
      else
        got := pg_temp.k0507_as('authenticated', moved, format(
          'insert into public.invites (family_id, email, role, invited_by) values (%L, %L, %L, %L)',
          kid_home, 'k0507-stranger@example.com', 'adult', moved));
        if got is distinct from 'OK 1' then
          failures := array_append(failures, format('NEGATIVE CONTROL: as its new household''s parent the moved kid login could not invite the stranger (%s), so this fixture cannot see the limit', got));
        end if;
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. families_insert stops asking.
    begin
      drop policy families_insert on public.families;
      create policy families_insert on public.families for insert with check (created_by = auth.uid());
      got := pg_temp.k0507_as('authenticated', kid, pg_temp.k0507_new_family('00000000-0000-4000-8507-0000000000f9', 'Kid''s Own House', kid));
      if got is distinct from 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with families_insert no longer asking, the kid login on the domain still could not start a household (%s), so 1. cannot catch that policy', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a kid login can still start a household of its own:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-kid-login-does-not-start-a-household: OK (a kid login on the domain and marked, one known only by its app_metadata mark and one known only by its address were each refused with 42501 "new row violates row-level security policy for table families" (exact), and none belongs to a household besides its own family; Real Home''s parent and an adult whose user_metadata says child each started a household as its parent; the service role with the kid''s user id and a session-less writer each created a family; is_child_login_account() reads the mapping, the domain and the mark, pinned SECURITY DEFINER, not executable by PUBLIC or anon, and families_insert asks it; negative control: with 0482''s test put back the moved kid login''s household landed and it invited the stranger; mutation control: with families_insert no longer asking, the kid login on the domain started a household)';
end $$;

rollback;
