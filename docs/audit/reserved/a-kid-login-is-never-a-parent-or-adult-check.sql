-- ── A kid login is never a parent or adult (0512) ────────────────────────────
--
-- A kid login is a username and a 4-digit PIN. #981 stops the app making one
-- for a parent or adult; the other order was open: promote a child who has one
-- to adult or parent and the PIN now guards a manager. The held 0512 refuses,
-- from both sides: a parent or adult role for a member whose account is a kid
-- login (its synthetic address or the server's mark, never a mapping alone:
-- 0495's reason), and a kid-login mapping for a parent or adult.
--
-- Fixture, Promo House: the parent; a kid with a PIN login (a child_logins
-- row, the synthetic address, the server's mark); a kid known only by the
-- mark (their address moved off the synthetic domain, no mapping); a kid known
-- only by the synthetic address; a teen with their own email; a ward with no
-- login; and an adult whose row already carries a kid login (stored before the
-- guard, as an older release could have left it).
--
-- What this probe asserts, each outcome exact:
--
--   1. as the parent through PostgREST's role, promoting the PIN kid to adult
--      or to parent is refused (42501);
--   2. so is promoting the kid known only by the mark, and the kid known only
--      by the address;
--   3. the service role is held to the same rule (42501);
--   4. the service role cannot map a kid login onto a parent or adult, nor
--      onto a child row with an account that is a parent of another household
--      (42501 each): the rule is the account's, in every family;
--   5. control: promoting the teen with their own email (after a kid-login
--      mapping is written onto that ordinary account, as a household's parent
--      could: a mapping is not an account's identity) and the ward with no
--      login is OK 1 each, the PIN kid can be made a teen (OK 1), their name
--      can be edited with the role the editor sends unchanged (OK 1), and the
--      adult already stored with a kid login can be renamed (OK 1): nothing
--      stored is refused for being there;
--   6. control: a kid login can still be mapped onto a child (OK 1);
--   7. control: once the server removes the PIN kid's login (the mapping and
--      the link), the parent promotes them (OK 1), which is the step the
--      refusal points to;
--   8. wiring: the two guards are enabled, one per table, SECURITY DEFINER
--      with a pinned search_path, and executable by neither anon nor
--      authenticated;
--
-- and, only where 0512 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the family_members trigger dropped, the
--       parent's promotion of the PIN kid lands (OK 1): the fixture reaches
--       the defect;
--   M1. MUTATION CONTROL: with the guard's mark test removed, the kid known
--       only by the mark is promoted (OK 1), so 2. catches a guard that
--       forgets it.
--
-- Everything is rolled back.
--
-- HELD with 0512: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/kid-login-manager-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0512 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8512-0000000000a1','k0512-parent@example.com','{}'),
  ('00000000-0000-4000-8512-0000000000a2','k0512-pin@kids.bubaly.app','{"bubaly_kid_login": true}'),
  ('00000000-0000-4000-8512-0000000000a3','k0512-moved@example.com','{"bubaly_kid_login": true}'),
  ('00000000-0000-4000-8512-0000000000a4','k0512-domain@kids.bubaly.app','{}'),
  ('00000000-0000-4000-8512-0000000000a5','k0512-teen@example.com','{}'),
  ('00000000-0000-4000-8512-0000000000a6','k0512-old@kids.bubaly.app','{"bubaly_kid_login": true}'),
  ('00000000-0000-4000-8512-0000000000a7','k0512-new@kids.bubaly.app','{"bubaly_kid_login": true}'),
  ('00000000-0000-4000-8512-0000000000a8','k0512-onparent@kids.bubaly.app','{"bubaly_kid_login": true}'),
  ('00000000-0000-4000-8512-0000000000a9','k0512-elsewhere@example.com','{}')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8512-0000000000f1','Promo House','00000000-0000-4000-8512-0000000000a1'),
  ('00000000-0000-4000-8512-0000000000f2','Elsewhere','00000000-0000-4000-8512-0000000000a9');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8512-0000000000a1', '00000000-0000-4000-8512-0000000000a9');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8512-0000000000c2','00000000-0000-4000-8512-0000000000f1','00000000-0000-4000-8512-0000000000a2','PIN kid','child',true),
  ('00000000-0000-4000-8512-0000000000c3','00000000-0000-4000-8512-0000000000f1','00000000-0000-4000-8512-0000000000a3','Moved kid','child',true),
  ('00000000-0000-4000-8512-0000000000c4','00000000-0000-4000-8512-0000000000f1','00000000-0000-4000-8512-0000000000a4','Domain kid','child',true),
  ('00000000-0000-4000-8512-0000000000c5','00000000-0000-4000-8512-0000000000f1','00000000-0000-4000-8512-0000000000a5','Teen','teen',true),
  ('00000000-0000-4000-8512-0000000000c7','00000000-0000-4000-8512-0000000000f1',null,'Ward','child',true),
  ('00000000-0000-4000-8512-0000000000c8','00000000-0000-4000-8512-0000000000f1',null,'New kid','child',true),
  ('00000000-0000-4000-8512-0000000000c9','00000000-0000-4000-8512-0000000000f1',null,'Another kid','child',true);
insert into public.child_logins (family_id, member_id, user_id, username) values
  ('00000000-0000-4000-8512-0000000000f1','00000000-0000-4000-8512-0000000000c2','00000000-0000-4000-8512-0000000000a2','k0512pin');
-- The adult stored with a kid login before the guard existed: written with
-- triggers off, as an older release could have left it.
set local session_replication_role = replica;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8512-0000000000c6','00000000-0000-4000-8512-0000000000f1','00000000-0000-4000-8512-0000000000a6','Old adult','adult',true);
insert into public.child_logins (family_id, member_id, user_id, username) values
  ('00000000-0000-4000-8512-0000000000f1','00000000-0000-4000-8512-0000000000c6','00000000-0000-4000-8512-0000000000a6','k0512old');
set local session_replication_role = origin;

-- One statement as one role, and exactly what happened.
create or replace function pg_temp.k0512_as(p_role text, p_uid text, p_sql text) returns text
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
    got := sqlstate;
  end;
  perform set_config('role', 'postgres', true);
  return got;
end
$fn$;

do $$
declare
  parent    constant text := '00000000-0000-4000-8512-0000000000a1';
  fam       constant uuid := '00000000-0000-4000-8512-0000000000f1';
  installed boolean := to_regprocedure('public.a_kid_login_is_never_a_manager()') is not null;
  failures  text[] := '{}';
  x         record;
  got       text;
  fn_src    text;
  promote   constant text := 'update public.family_members set role = %L where id = %L and family_id = %L';
begin
  -- 1-3. The promotions the guard refuses.
  for x in select * from (values
      ('the parent made the PIN kid an adult',               'authenticated', parent, 'adult',  '00000000-0000-4000-8512-0000000000c2'),
      ('the parent made the PIN kid a parent',               'authenticated', parent, 'parent', '00000000-0000-4000-8512-0000000000c2'),
      ('the parent made the kid known only by the mark an adult',    'authenticated', parent, 'adult', '00000000-0000-4000-8512-0000000000c3'),
      ('the parent made the kid known only by the address an adult', 'authenticated', parent, 'adult', '00000000-0000-4000-8512-0000000000c4'),
      ('the service role made the PIN kid an adult',         'service_role', null, 'adult',  '00000000-0000-4000-8512-0000000000c2')) as v(what, role, uid, to_role, member) loop
    got := pg_temp.k0512_as(x.role, x.uid, format(promote, x.to_role, x.member, fam));
    if got is distinct from '42501' then
      failures := array_append(failures, format('%s (%s, not 42501)', x.what, got));
    end if;
  end loop;

  -- 4. A kid login mapped onto a parent or adult.
  got := pg_temp.k0512_as('service_role', null, format(
    'insert into public.child_logins (family_id, member_id, user_id, username) values (%L, %L, %L, %L)',
    fam, (select id from public.family_members where family_id = fam and role = 'parent' limit 1),
    '00000000-0000-4000-8512-0000000000a8', 'k0512onparent'));
  if got is distinct from '42501' then
    failures := array_append(failures, format('the service role mapped a kid login onto the parent (%s, not 42501)', got));
  end if;
  got := pg_temp.k0512_as('service_role', null, format(
    'insert into public.child_logins (family_id, member_id, user_id, username) values (%L, %L, %L, %L)',
    fam, '00000000-0000-4000-8512-0000000000c9', '00000000-0000-4000-8512-0000000000a9', 'k0512elsewhere'));
  if got is distinct from '42501' then
    failures := array_append(failures, format('the service role mapped a kid login for an account that is a parent of another household (%s, not 42501)', got));
  end if;

  -- 5. What stays allowed. First a mapping onto the teen's ordinary account,
  --    as a household's parent could write one (0297): it must not make them
  --    a kid login.
  got := pg_temp.k0512_as('service_role', null, format(
    'insert into public.child_logins (family_id, member_id, user_id, username) values (%L, %L, %L, %L)',
    fam, '00000000-0000-4000-8512-0000000000c5', '00000000-0000-4000-8512-0000000000a5', 'k0512poison'));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the mapping onto the teen''s ordinary account could not be written (%s)', got));
  end if;
  for x in select * from (values
      ('promoting the teen with their own email and a mapping onto it', format(promote, 'adult', '00000000-0000-4000-8512-0000000000c5', fam)),
      ('promoting the ward with no login',             format(promote, 'adult', '00000000-0000-4000-8512-0000000000c7', fam)),
      ('making the PIN kid a teen',                    format(promote, 'teen',  '00000000-0000-4000-8512-0000000000c2', fam)),
      ('renaming the PIN kid with the role unchanged', format('update public.family_members set display_name = %L, role = %L where id = %L and family_id = %L',
                                                              'PIN kid (renamed)', 'teen', '00000000-0000-4000-8512-0000000000c2', fam)),
      ('renaming the adult already stored with a kid login', format('update public.family_members set display_name = %L, role = %L where id = %L and family_id = %L',
                                                              'Old adult (renamed)', 'adult', '00000000-0000-4000-8512-0000000000c6', fam))) as v(what, q) loop
    got := pg_temp.k0512_as('authenticated', parent, x.q);
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s was %s, not OK 1', x.what, got));
    end if;
  end loop;

  -- 6. A kid login onto a child still maps.
  got := pg_temp.k0512_as('service_role', null, format(
    'insert into public.child_logins (family_id, member_id, user_id, username) values (%L, %L, %L, %L)',
    fam, '00000000-0000-4000-8512-0000000000c8', '00000000-0000-4000-8512-0000000000a7', 'k0512new'));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: mapping a kid login onto a child was %s, not OK 1', got));
  end if;

  -- 7. The path the refusal points to: the server removes the login, then the
  --    parent promotes. (The PIN kid is a teen after 5.)
  got := pg_temp.k0512_as('service_role', null, format('delete from public.child_logins where member_id = %L', '00000000-0000-4000-8512-0000000000c2'));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the server could not remove the kid login mapping (%s)', got));
  end if;
  got := pg_temp.k0512_as('service_role', null, format('update public.family_members set user_id = null where id = %L and user_id = %L',
    '00000000-0000-4000-8512-0000000000c2', '00000000-0000-4000-8512-0000000000a2'));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the server could not unlink the kid login (%s)', got));
  end if;
  got := pg_temp.k0512_as('authenticated', parent, format(promote, 'adult', '00000000-0000-4000-8512-0000000000c2', fam));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: with the kid login removed the parent still could not promote the member (%s)', got));
  end if;

  -- 8. Wiring.
  if not exists (select 1 from pg_trigger t where t.tgname = 'a_kid_login_is_never_a_manager' and not t.tgisinternal
                    and t.tgenabled = 'O' and t.tgrelid = 'public.family_members'::regclass)
     or not exists (select 1 from pg_trigger t where t.tgname = 'a_manager_is_never_a_kid_login' and not t.tgisinternal
                    and t.tgenabled = 'O' and t.tgrelid = 'public.child_logins'::regclass) then
    failures := array_append(failures, 'the guards are not enabled on family_members and child_logins');
  end if;
  if not installed or to_regprocedure('public.a_manager_is_never_a_kid_login()') is null then
    failures := array_append(failures, 'the guard functions a_kid_login_is_never_a_manager() and a_manager_is_never_a_kid_login() are missing');
  elsif (select count(*) from pg_proc f
          where f.oid in (to_regprocedure('public.a_kid_login_is_never_a_manager()'), to_regprocedure('public.a_manager_is_never_a_kid_login()'))
            and f.prosecdef and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')
            and not has_function_privilege('anon', f.oid, 'execute')
            and not has_function_privilege('authenticated', f.oid, 'execute')) <> 2 then
    failures := array_append(failures, 'a guard function is not SECURITY DEFINER with a pinned search_path, or is executable by anon or authenticated');
  end if;

  if installed then
    -- N1. The family_members trigger dropped.
    begin
      drop trigger a_kid_login_is_never_a_manager on public.family_members;
      got := pg_temp.k0512_as('authenticated', parent, format(promote, 'adult', '00000000-0000-4000-8512-0000000000c3', fam));
      if got is distinct from 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the trigger dropped the parent''s promotion did not land (%s), so this fixture cannot reach the defect', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The mark test removed.
    begin
      fn_src := pg_get_functiondef(to_regprocedure('public.a_kid_login_is_never_a_manager()'));
      fn_src := replace(fn_src, $r$or coalesce(u.raw_app_meta_data->>'bubaly_kid_login', '') = 'true'$r$, '');
      if position('bubaly_kid_login' in fn_src) > 0 then
        failures := array_append(failures, 'MUTATION CONTROL could not remove the mark test from the guard');
      else
        execute fn_src;
        got := pg_temp.k0512_as('authenticated', parent, format(promote, 'adult', '00000000-0000-4000-8512-0000000000c3', fam));
        if got is distinct from 'OK 1' then
          failures := array_append(failures, format('MUTATION CONTROL: without the mark test the kid known only by the mark was still refused (%s), so 2. cannot catch that guard', got));
        end if;
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a kid login can be a parent or adult:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-kid-login-is-never-a-parent-or-adult: OK (the parent''s promotion of the PIN kid to adult and to parent, and of the kids known only by the mark or only by the address, is refused 42501, and so is the service role''s; the service role cannot map a kid login onto the parent, nor for an account that is a parent of another household (42501); promoting the teen with their own email (a mapping written onto it notwithstanding) and the ward with no login, making the PIN kid a teen, renaming them, and renaming the adult already stored with a kid login are OK 1; a kid login still maps onto a child (OK 1); once the server removes the login the parent promotes the member (OK 1); the two guards are enabled, one per table, SECURITY DEFINER with a pinned search_path and not executable by anon or authenticated; negative control: with the trigger dropped the promotion lands; mutation control: without the mark test the kid known only by the mark is promoted)';
end $$;

rollback;
