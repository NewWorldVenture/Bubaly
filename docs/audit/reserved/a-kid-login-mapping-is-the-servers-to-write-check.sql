-- ── A kid login mapping is the server's to write (0504) ─────────────────────
--
-- child_logins maps a kid login's username to its synthetic auth user and the
-- member row it signs in as. 0297 left a manager write policy on it, and the
-- client roles kept every DML grant, though the application writes every
-- mapping through the service role. The held 0504 drops that policy and the
-- client writes. The limit it closes (0495's): a household's parent demotes one
-- of its own adults to a non-manager role and writes a mapping onto that
-- adult's account, after which the adult's invitations elsewhere are refused
-- as a kid login's.
--
-- What this probe asserts, through PostgREST's role, each outcome exact
-- (`OK <rows>` or the SQLSTATE and message):
--
--   1. the parent's mapping onto the demoted adult's account is refused with
--      42501 "permission denied for table child_logins" (the table privilege
--      the client no longer holds), and no such row exists (counted);
--   2. the parent's repointing of an existing kid login at their own account,
--      and the parent's delete of it, are refused the same way, and the row is
--      unchanged (counted);
--   3. the child's own writes are refused the same way;
--   4. control: the parent and the child still read the family's mappings
--      (the family-access page and the kid surfaces);
--   5. control: the service role (carrying the parent's user id) writes,
--      renames and removes a second kid's mapping (counted);
--   6. wiring: no permissive client write policy on child_logins, no client
--      INSERT/UPDATE/DELETE, and the members' read kept;
--
-- and, only where 0504 is installed, in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with 0297's manager policy and the client grants put
--       back, the parent's mapping onto the adult lands (OK 1): the fixture
--       reaches the limit 0504 closes.
--
-- Everything is rolled back.
--
-- HELD with 0504: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/kid-login-mapping-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0504 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8504-0000000000a1','k0504-parent@example.com'),
  ('00000000-0000-4000-8504-0000000000a2','k0504-adult@example.com'),
  ('00000000-0000-4000-8504-0000000000a3','child.k0504kid@kids.bubaly.app'),
  ('00000000-0000-4000-8504-0000000000a4','child.k0504new@kids.bubaly.app')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8504-0000000000f1','Login House','00000000-0000-4000-8504-0000000000a1');
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8504-0000000000a1';
-- The adult, already demoted to a non-manager role by the parent.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8504-0000000000c2','00000000-0000-4000-8504-0000000000f1','00000000-0000-4000-8504-0000000000a2','Grown-up (demoted)','caregiver',true),
  ('00000000-0000-4000-8504-0000000000c3','00000000-0000-4000-8504-0000000000f1','00000000-0000-4000-8504-0000000000a3','Kid','child',true),
  -- A second kid with no login yet: the service role's own control row.
  ('00000000-0000-4000-8504-0000000000c4','00000000-0000-4000-8504-0000000000f1','00000000-0000-4000-8504-0000000000a4','New kid','child',true);
-- The kid's real login, written as the server writes it.
insert into public.child_logins (id, family_id, member_id, user_id, username, created_by) values
  ('00000000-0000-4000-8504-0000000000e3','00000000-0000-4000-8504-0000000000f1','00000000-0000-4000-8504-0000000000c3',
   '00000000-0000-4000-8504-0000000000a3','k0504kid','00000000-0000-4000-8504-0000000000a1');

-- One statement as one signed-in user, and exactly what happened.
create or replace function pg_temp.k0504_as(p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
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
  fam       constant uuid := '00000000-0000-4000-8504-0000000000f1';
  parent    constant text := '00000000-0000-4000-8504-0000000000a1';
  adult_u   constant uuid := '00000000-0000-4000-8504-0000000000a2';
  adult_m   constant uuid := '00000000-0000-4000-8504-0000000000c2';
  kid       constant text := '00000000-0000-4000-8504-0000000000a3';
  kid_row   constant uuid := '00000000-0000-4000-8504-0000000000e3';
  refused   constant text := '42501: permission denied for table child_logins';
  installed boolean := not has_table_privilege('authenticated', 'public.child_logins', 'insert');
  failures  text[] := '{}';
  t         record;
  got       text;
  n         int;
begin
  -- 1. The parent maps a kid login onto the demoted adult's account.
  got := pg_temp.k0504_as(parent, format(
    'insert into public.child_logins (family_id, member_id, user_id, username, created_by) values (%L, %L, %L, %L, %L)',
    fam, adult_m, adult_u, 'k0504grownup', parent));
  if got is distinct from refused then
    failures := array_append(failures, format('a parent wrote a kid-login mapping onto a grown-up''s account (%s)', got));
  end if;
  select count(*) into n from public.child_logins where member_id = adult_m;
  if n <> 0 then
    failures := array_append(failures, format('the grown-up''s account carries %s kid-login mapping(s)', n));
  end if;

  -- 2-3. Repointing and removing the kid's login, as the parent and as the kid.
  for t in select * from (values
      (parent, 'a parent', 'repointed the kid''s login at their own account', format('update public.child_logins set user_id = %L where id = %L', parent, kid_row)),
      (parent, 'a parent', 'deleted the kid''s login', format('delete from public.child_logins where id = %L', kid_row)),
      (kid,    'the kid',  'renamed their own login', format('update public.child_logins set username = %L where id = %L', 'k0504renamed', kid_row)),
      (kid,    'the kid',  'deleted their own login', format('delete from public.child_logins where id = %L', kid_row))
    ) as v(uid, who, what, stmt) loop
    got := pg_temp.k0504_as(t.uid, t.stmt);
    if got is distinct from refused then
      failures := array_append(failures, format('%s %s (%s)', t.who, t.what, got));
    end if;
  end loop;
  select count(*) into n from public.child_logins
   where id = kid_row and user_id = kid::uuid and username = 'k0504kid' and member_id = '00000000-0000-4000-8504-0000000000c3';
  if n <> 1 then
    failures := array_append(failures, format('the kid''s login is not there unchanged (%s rows)', n));
  end if;

  -- 4. Reads stay.
  for t in select * from (values (parent, 'the parent'), (kid, 'the kid')) as v(uid, who) loop
    got := pg_temp.k0504_as(t.uid, format('select 1 from public.child_logins where family_id = %L', fam));
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s can no longer read the family''s kid logins (%s)', t.who, got));
    end if;
  end loop;

  -- 5. The service role (carrying the parent's user id) writes, repoints and removes.
  begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claim.sub', parent, true);
    perform set_config('request.jwt.claims', json_build_object('sub', parent, 'role', 'service_role')::text, true);
    insert into public.child_logins (id, family_id, member_id, user_id, username, created_by)
      values ('00000000-0000-4000-8504-0000000000e9', fam, '00000000-0000-4000-8504-0000000000c4',
              '00000000-0000-4000-8504-0000000000a4', 'k0504server', parent::uuid);
    update public.child_logins set username = 'k0504server2' where id = '00000000-0000-4000-8504-0000000000e9';
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('CONTROL (service role): its update changed %s rows, not 1', n));
    end if;
    delete from public.child_logins where id = '00000000-0000-4000-8504-0000000000e9';
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('CONTROL (service role): its delete removed %s rows, not 1', n));
    end if;
    perform set_config('role', 'postgres', true);
  exception when others then
    perform set_config('role', 'postgres', true);
    failures := array_append(failures, format('CONTROL (service role): refused (%s: %s)', sqlstate, sqlerrm));
  end;

  -- 6. Wiring.
  select count(*) into n
    from pg_policy p
   where p.polrelid = 'public.child_logins'::regclass
     and p.polpermissive and p.polcmd in ('*', 'a', 'w', 'd')
     and (p.polroles = array[0::oid]
          or p.polroles && array[(select oid from pg_roles where rolname = 'authenticated'),
                                 (select oid from pg_roles where rolname = 'anon')]);
  if n <> 0 then
    failures := array_append(failures, format('child_logins carries %s permissive write polic(ies) for a client role', n));
  end if;
  if has_table_privilege('authenticated', 'public.child_logins', 'insert')
     or has_table_privilege('authenticated', 'public.child_logins', 'update')
     or has_table_privilege('authenticated', 'public.child_logins', 'delete')
     or has_table_privilege('anon', 'public.child_logins', 'insert')
     or has_table_privilege('anon', 'public.child_logins', 'update')
     or has_table_privilege('anon', 'public.child_logins', 'delete') then
    failures := array_append(failures, 'a client role still holds INSERT, UPDATE or DELETE on child_logins');
  end if;
  if not exists (select 1 from pg_policy p where p.polrelid = 'public.child_logins'::regclass and p.polcmd = 'r') then
    failures := array_append(failures, 'CONTROL: the members'' read policy on child_logins is gone');
  end if;

  -- N1. With 0297's rule put back, the parent's mapping onto the adult lands.
  if installed then
    begin
      grant insert, update, delete on public.child_logins to authenticated;
      drop policy if exists "Managers manage child_logins" on public.child_logins;
      create policy "Managers manage child_logins" on public.child_logins
        for all using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
      got := pg_temp.k0504_as(parent, format(
        'insert into public.child_logins (family_id, member_id, user_id, username, created_by) values (%L, %L, %L, %L, %L)',
        fam, adult_m, adult_u, 'k0504grownup', parent));
      if got is distinct from 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with 0297''s rule put back the parent''s mapping onto the grown-up did not land (%s), so this fixture cannot see the limit', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a household can still write a kid-login mapping:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-kid-login-mapping-is-the-servers-to-write: OK (the parent''s mapping onto a demoted grown-up''s account, their repoint and delete of the kid''s login, and the kid''s own rename and delete were each refused with 42501 "permission denied for table child_logins" (exact); no mapping reached the grown-up and the kid''s login is unchanged; the parent and the kid still read the family''s logins; the service role (with a user id) wrote, renamed and removed a second kid''s mapping (1 row each); no client write policy or grant remains and the members'' read is kept; negative control: with 0297''s rule put back the parent''s mapping onto the grown-up landed)';
end $$;

rollback;
