-- ── A removed member keeps no social raise (0513) ────────────────────────────
--
-- social_access_permissions rows outlive a member's removal, and
-- social_role_for prefers them over the role's default, so a member invited
-- back got their old explicit social role again. The held 0513 clears, on
-- removal (is_active to false, or the row deleted), a grant above the role's
-- default; a grant within it (a restriction) stays.
--
-- Fixture, Social House: the parent, and members each holding one explicit
-- grant: a teen made `admin` (a raise), a teen held to `read_only` (a
-- restriction), a child made `approver` (adds approve_posts, loses nothing a
-- child has: a raise), a teen made `analyst` (adds view_analytics, loses
-- create_drafts: mixed, which counts as a raise), an adult at
-- `marketing_manager` (their default exactly), a teen at `social_manager`
-- whose row the server deletes, and an active teen made `admin` who is only
-- renamed and promoted. The `admin` teen is also a member of a second
-- household with a grant there.
--
-- What this probe asserts:
--
--   1. the parent's removal (family-module's REMOVED_MEMBER_PATCH, through
--      PostgREST's role) clears the `admin` teen's, the `approver` child's and
--      the `analyst` teen's grants, and the server's delete of a member row
--      clears that member's `social_manager` grant;
--   2. the removal keeps the `read_only` teen's restriction and the adult's
--      grant at their default;
--   3. invited back (reactivated as a teen, as accept_invite does), the
--      `admin` teen's social role is the teen default, `content_creator`, and
--      the restricted teen's is still `read_only`;
--   4. control: an active member's grant is untouched by a rename or a role
--      change (OK 1 each, grant still `admin`), and the removed teen's grant
--      in their other household stays;
--   5. wiring: the trigger is enabled, its function SECURITY DEFINER with a
--      pinned search_path and executable by no client role; and
--      social_role_permissions agrees with social_has_permission for every
--      role and permission (as a member holding each role in turn);
--
-- and, only where 0513 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the trigger dropped, the parent's removal
--       leaves the `admin` teen's grant: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with a rule that clears only `owner` and `admin`
--       grants, the `approver` child's grant survives removal, so 1. catches a
--       rule narrower than "any permission the default lacks".
--
-- Everything is rolled back.
--
-- HELD with 0513: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/social-raise-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0513 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8513-0000000000a1','s0513-parent@example.com'),
  ('00000000-0000-4000-8513-0000000000a2','s0513-raised@example.com'),
  ('00000000-0000-4000-8513-0000000000a3','s0513-limited@example.com'),
  ('00000000-0000-4000-8513-0000000000a4','s0513-approver@example.com'),
  ('00000000-0000-4000-8513-0000000000a5','s0513-adult@example.com'),
  ('00000000-0000-4000-8513-0000000000a6','s0513-analyst@example.com'),
  ('00000000-0000-4000-8513-0000000000a7','s0513-deleted@example.com'),
  ('00000000-0000-4000-8513-0000000000a8','s0513-active@example.com'),
  ('00000000-0000-4000-8513-0000000000a9','s0513-other-parent@example.com')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8513-0000000000f1','Social House','00000000-0000-4000-8513-0000000000a1'),
  ('00000000-0000-4000-8513-0000000000f2','Other House','00000000-0000-4000-8513-0000000000a9');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8513-0000000000a1','00000000-0000-4000-8513-0000000000a9');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8513-0000000000c2','00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a2','Raised teen','teen',true),
  ('00000000-0000-4000-8513-0000000000c3','00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a3','Limited teen','teen',true),
  ('00000000-0000-4000-8513-0000000000c4','00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a4','Approver child','child',true),
  ('00000000-0000-4000-8513-0000000000c5','00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a5','Adult','adult',true),
  ('00000000-0000-4000-8513-0000000000c6','00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a6','Analyst teen','teen',true),
  ('00000000-0000-4000-8513-0000000000c7','00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a7','Deleted teen','teen',true),
  ('00000000-0000-4000-8513-0000000000c8','00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a8','Active teen','teen',true),
  ('00000000-0000-4000-8513-0000000000d2','00000000-0000-4000-8513-0000000000f2','00000000-0000-4000-8513-0000000000a2','Raised teen elsewhere','teen',true);
insert into public.social_access_permissions (family_id, user_id, member_id, social_role, status, granted_by) values
  ('00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a2','00000000-0000-4000-8513-0000000000c2','admin','active','00000000-0000-4000-8513-0000000000a1'),
  ('00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a3','00000000-0000-4000-8513-0000000000c3','read_only','active','00000000-0000-4000-8513-0000000000a1'),
  ('00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a4','00000000-0000-4000-8513-0000000000c4','approver','active','00000000-0000-4000-8513-0000000000a1'),
  ('00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a5','00000000-0000-4000-8513-0000000000c5','marketing_manager','active','00000000-0000-4000-8513-0000000000a1'),
  ('00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a6','00000000-0000-4000-8513-0000000000c6','analyst','active','00000000-0000-4000-8513-0000000000a1'),
  ('00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a7','00000000-0000-4000-8513-0000000000c7','social_manager','active','00000000-0000-4000-8513-0000000000a1'),
  ('00000000-0000-4000-8513-0000000000f1','00000000-0000-4000-8513-0000000000a8','00000000-0000-4000-8513-0000000000c8','admin','active','00000000-0000-4000-8513-0000000000a1'),
  ('00000000-0000-4000-8513-0000000000f2','00000000-0000-4000-8513-0000000000a2','00000000-0000-4000-8513-0000000000d2','admin','active','00000000-0000-4000-8513-0000000000a9');

-- One statement as one role, and exactly what happened.
create or replace function pg_temp.s0513_as(p_role text, p_uid text, p_sql text) returns text
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

-- The grant one user holds in one family, as stored ('none' when there is none).
create or replace function pg_temp.s0513_grant(fam uuid, uid uuid) returns text
language sql as $fn$
  select coalesce((select social_role::text from public.social_access_permissions where family_id = fam and user_id = uid), 'none')
$fn$;

-- The social role one user resolves to in one family, as they see it.
create or replace function pg_temp.s0513_role_for(fam uuid, uid text) returns text
language plpgsql as $fn$
declare r text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  r := public.social_role_for(fam)::text;
  perform set_config('role', 'postgres', true);
  return coalesce(r, 'none');
end
$fn$;

do $$
declare
  f1        constant uuid := '00000000-0000-4000-8513-0000000000f1';
  f2        constant uuid := '00000000-0000-4000-8513-0000000000f2';
  parent    constant text := '00000000-0000-4000-8513-0000000000a1';
  installed boolean := to_regprocedure('public.a_removed_member_keeps_no_social_raise()') is not null;
  remove    constant text := 'update public.family_members set is_active = false, role = %L where id = %L and family_id = %L';
  failures  text[] := '{}';
  x         record;
  got       text;
  perms     constant text[] := array['connect_accounts','view_feed','create_drafts','generate_ai','upload_media',
                                     'publish_posts','schedule_posts','approve_posts','view_analytics','manage_settings','manage_access'];
  r         text;
  p         text;
  has       boolean;
  bad       text[] := '{}';
begin
  -- 1-2. The parent removes five members; the server deletes one row.
  for x in select * from (values ('00000000-0000-4000-8513-0000000000c2'), ('00000000-0000-4000-8513-0000000000c3'),
                                 ('00000000-0000-4000-8513-0000000000c4'), ('00000000-0000-4000-8513-0000000000c5'),
                                 ('00000000-0000-4000-8513-0000000000c6')) as v(member) loop
    got := pg_temp.s0513_as('authenticated', parent, format(remove, 'guest', x.member, f1));
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: the parent could not remove member %s (%s)', x.member, got));
    end if;
  end loop;
  got := pg_temp.s0513_as('service_role', null, format('delete from public.family_members where id = %L', '00000000-0000-4000-8513-0000000000c7'));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the server could not delete a member row (%s)', got));
  end if;

  for x in select * from (values
      ('the removed teen made admin',       '00000000-0000-4000-8513-0000000000a2', 'none'),
      ('the removed child made approver',   '00000000-0000-4000-8513-0000000000a4', 'none'),
      ('the removed teen made analyst',     '00000000-0000-4000-8513-0000000000a6', 'none'),
      ('the deleted teen made social_manager', '00000000-0000-4000-8513-0000000000a7', 'none')) as v(who, uid, want) loop
    got := pg_temp.s0513_grant(f1, x.uid::uuid);
    if got <> x.want then
      failures := array_append(failures, format('%s keeps the raise (%s)', x.who, got));
    end if;
  end loop;
  for x in select * from (values
      ('the removed teen held to read_only', '00000000-0000-4000-8513-0000000000a3', 'read_only'),
      ('the removed adult at their default', '00000000-0000-4000-8513-0000000000a5', 'marketing_manager')) as v(who, uid, want) loop
    got := pg_temp.s0513_grant(f1, x.uid::uuid);
    if got <> x.want then
      failures := array_append(failures, format('CONTROL: %s lost their grant (%s, not %s)', x.who, got, x.want));
    end if;
  end loop;

  -- 3. Invited back.
  update public.family_members set is_active = true, role = 'teen'
   where id in ('00000000-0000-4000-8513-0000000000c2', '00000000-0000-4000-8513-0000000000c3');
  got := pg_temp.s0513_role_for(f1, '00000000-0000-4000-8513-0000000000a2');
  if got <> 'content_creator' then
    failures := array_append(failures, format('the teen made admin, invited back, is %s, not the teen default content_creator', got));
  end if;
  got := pg_temp.s0513_role_for(f1, '00000000-0000-4000-8513-0000000000a3');
  if got <> 'read_only' then
    failures := array_append(failures, format('CONTROL: the restricted teen, invited back, is %s, not read_only', got));
  end if;

  -- 4. An active member's grant, and the other household's.
  got := pg_temp.s0513_as('authenticated', parent, format('update public.family_members set display_name = %L where id = %L and family_id = %L',
    'Active teen (renamed)', '00000000-0000-4000-8513-0000000000c8', f1));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the parent could not rename an active member (%s)', got));
  end if;
  got := pg_temp.s0513_as('authenticated', parent, format('update public.family_members set role = %L where id = %L and family_id = %L',
    'adult', '00000000-0000-4000-8513-0000000000c8', f1));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the parent could not change an active member''s role (%s)', got));
  end if;
  if pg_temp.s0513_grant(f1, '00000000-0000-4000-8513-0000000000a8') <> 'admin' then
    failures := array_append(failures, 'CONTROL: an active member''s grant changed on a rename or a role change');
  end if;
  if pg_temp.s0513_grant(f2, '00000000-0000-4000-8513-0000000000a2') <> 'admin' then
    failures := array_append(failures, 'CONTROL: the removed teen''s grant in their other household went with the removal');
  end if;

  -- 5. Wiring.
  if not installed or to_regprocedure('public.social_role_permissions(public.social_role)') is null then
    failures := array_append(failures, 'the trigger function and social_role_permissions are missing');
  else
    if not exists (select 1 from pg_trigger t where t.tgname = 'a_removed_member_keeps_no_social_raise' and not t.tgisinternal
                    and t.tgenabled = 'O' and t.tgrelid = 'public.family_members'::regclass)
       or not exists (select 1 from pg_proc f where f.oid = to_regprocedure('public.a_removed_member_keeps_no_social_raise()')
                       and f.prosecdef and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')
                       and not has_function_privilege('anon', f.oid, 'execute')
                       and not has_function_privilege('authenticated', f.oid, 'execute')) then
      failures := array_append(failures, 'the trigger is not enabled, or its function is not pinned SECURITY DEFINER and closed to clients');
    end if;
    -- The matrix, as a member holding each role in turn.
    foreach r in array (select array_agg(e::text) from unnest(enum_range(null::public.social_role)) e) loop
      update public.social_access_permissions set social_role = r::public.social_role
       where family_id = f1 and user_id = '00000000-0000-4000-8513-0000000000a8';
      foreach p in array perms loop
        perform set_config('role', 'authenticated', true);
        perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8513-0000000000a8', true);
        has := public.social_has_permission(f1, p);
        perform set_config('role', 'postgres', true);
        if has is distinct from (p = any (public.social_role_permissions(r::public.social_role))) then
          bad := array_append(bad, format('%s/%s', r, p));
        end if;
      end loop;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('social_role_permissions disagrees with social_has_permission on %s', array_to_string(bad, ', ')));
    end if;
  end if;

  if installed then
    -- N1. The trigger dropped.
    begin
      drop trigger a_removed_member_keeps_no_social_raise on public.family_members;
      got := pg_temp.s0513_as('authenticated', parent, format(remove, 'guest', '00000000-0000-4000-8513-0000000000c8', f1));
      if pg_temp.s0513_grant(f1, '00000000-0000-4000-8513-0000000000a8') = 'none' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the trigger dropped the removal still cleared the grant (%s), so this fixture cannot see the defect', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. A rule that clears only owner and admin.
    begin
      insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
        ('00000000-0000-4000-8513-0000000000c9', f1, '00000000-0000-4000-8513-0000000000a9', 'Mutation child', 'child', true);
      insert into public.social_access_permissions (family_id, user_id, member_id, social_role, status)
        values (f1, '00000000-0000-4000-8513-0000000000a9', '00000000-0000-4000-8513-0000000000c9', 'approver', 'active');
      create or replace function public.a_removed_member_keeps_no_social_raise()
      returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $m1$
      begin
        if old.user_id is not null and (tg_op = 'DELETE' or (old.is_active and not new.is_active)) then
          delete from public.social_access_permissions g
           where g.family_id = old.family_id and g.user_id = old.user_id and g.social_role in ('owner', 'admin');
        end if;
        return null;
      end
      $m1$;
      got := pg_temp.s0513_as('authenticated', parent, format(remove, 'guest', '00000000-0000-4000-8513-0000000000c9', f1));
      if pg_temp.s0513_grant(f1, '00000000-0000-4000-8513-0000000000a9') <> 'approver' then
        failures := array_append(failures, format('MUTATION CONTROL: under a rule that clears only owner and admin the approver child''s grant still went (%s), so 1. cannot catch that rule', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a removed member keeps a social raise:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-removed-member-keeps-no-social-raise: OK (the parent''s removal clears the admin teen''s, the approver child''s and the analyst teen''s grants and the server''s delete clears the social_manager teen''s; the read_only restriction and the adult''s grant at their default stay; invited back the admin teen is content_creator and the restricted teen read_only; an active member''s grant survives a rename and a role change, and the removed teen''s grant in their other household stays; the trigger is enabled, pinned and closed to clients, and social_role_permissions agrees with social_has_permission for every role and permission; negative control: with the trigger dropped the grant survives removal; mutation control: a rule clearing only owner and admin leaves the approver child''s grant)';
end $$;

rollback;
