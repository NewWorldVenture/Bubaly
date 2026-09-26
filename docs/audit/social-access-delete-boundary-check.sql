-- Behavioural proof for 0334, run as real `authenticated` sessions under RLS.
--
-- A social role is an explicit restriction OR an explicit grant, stored as one row
-- per (family, user) in social_access_permissions. With no row, social_role_for
-- falls back to a default by household role:
--
--   parent → admin     adult → marketing_manager     teen → content_creator
--
-- 0034 narrowed INSERT and UPDATE to `is_family_admin OR social_has_permission(
-- 'manage_access')` and left DELETE on the generic `is_family_member(family_id)`.
-- So an adult a parent had deliberately set to `read_only` could delete that row
-- and fall back to `marketing_manager` — connect accounts and publish as the
-- family. And the DELETE policy never checked `user_id`, so it was not only their
-- OWN restriction: any member could delete ANY member's row.
--
-- Recorded as AUTHZ-003 (Critical). The probe asserts what each role may still do:
-- a parent still deletes (the grant/revoke flow), and every member still READS the
-- roles, which the settings page renders.
grant usage on schema public to authenticated;

do $$
declare
  fam        uuid := 'aaa50000-0000-4000-8000-00000000005a';
  parent_uid uuid := 'a5000000-0000-4000-8000-000000000001';
  adult_uid  uuid := 'a5000000-0000-4000-8000-000000000002';
  teen_uid   uuid := 'a5000000-0000-4000-8000-000000000003';
  adult_row  uuid;
  teen_row   uuid;
  n          int;
  v_role     text;
  can_pub    boolean;
begin
  delete from public.social_access_permissions where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, adult_uid, teen_uid);
  delete from public.families where id = fam;

  insert into public.families (id, name) values (fam, 'Social') on conflict do nothing;
  insert into auth.users (id, email) values
    (parent_uid, 'sap@example.test'), (adult_uid, 'saa@example.test'), (teen_uid, 'sat@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, adult_uid,  'Adult',  'adult',  true),
    (fam, teen_uid,   'Teen',   'teen',   true);

  -- ── As the PARENT: restrict the adult and the teen explicitly ──────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  insert into public.social_access_permissions (family_id, user_id, social_role, status)
  values (fam, adult_uid, 'read_only', 'active') returning id into adult_row;
  insert into public.social_access_permissions (family_id, user_id, social_role, status)
  values (fam, teen_uid, 'read_only', 'active') returning id into teen_row;

  -- ── As the ADULT ─────────────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', adult_uid::text, true);
  set local role authenticated;

  -- The restriction is in force before anything is attempted.
  select public.social_role_for(fam)::text, public.social_has_permission(fam, 'publish_posts')
    into v_role, can_pub;
  if v_role <> 'read_only' or can_pub then
    raise exception 'fixture: the adult should start read_only without publish (got %, %)', v_role, can_pub;
  end if;

  -- 1. Cannot delete their own restriction. Before 0334: DELETE 1, and the role
  --    fell back to marketing_manager.
  delete from public.social_access_permissions where id = adult_row;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'an adult deleted their own read_only restriction';
  end if;
  select public.social_role_for(fam)::text, public.social_has_permission(fam, 'publish_posts')
    into v_role, can_pub;
  if v_role <> 'read_only' or can_pub then
    raise exception 'the adult''s role is now % with publish=% after a refused delete', v_role, can_pub;
  end if;

  -- 2. Cannot delete ANOTHER member's restriction either — the old policy never
  --    looked at user_id at all.
  delete from public.social_access_permissions where id = teen_row;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'an adult deleted another member''s social restriction';
  end if;

  -- 3. …and still READS the roles, which the settings page renders.
  select count(*) into n from public.social_access_permissions where family_id = fam;
  if n <> 2 then
    raise exception 'a member can no longer read the family''s social roles (%)', n;
  end if;

  -- ── As the PARENT: the revoke flow still works ───────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  delete from public.social_access_permissions where id = teen_row;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer revoke a member''s social role (%)', n;
  end if;

  -- ── No stray permissive DELETE policy survives ───────────────────────────
  reset role;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'social_access_permissions'
     and cmd in ('DELETE', 'ALL') and permissive = 'PERMISSIVE'
     and coalesce(qual, '') !~ '(is_family_admin|manage_access)';
  if n <> 0 then
    raise exception '% permissive DELETE policy(ies) on social_access_permissions do not require manage_access', n;
  end if;

  delete from public.social_access_permissions where family_id = fam;
  delete from public.family_members where family_id = fam;
  delete from public.families where id = fam;
  raise notice 'OK: a restricted member cannot delete their own or anyone''s social role; members still read roles; a parent still revokes.';
end $$;
