-- A restriction is not removable by the person it restricts. (AUTHZ-003)
--
-- `social_role_for` reads an explicit grant and falls back to the member's
-- family role when there is no row:
--
--   coalesce((select social_role from social_access_permissions
--               where family_id = ... and user_id = auth.uid() and status = 'active'),
--            (case fm.role when 'parent' then 'admin'
--                          when 'adult'  then 'marketing_manager' ... end))
--
-- A coalesce over a deletable row is a privilege that grows back. INSERT and
-- UPDATE were tightened to `is_family_admin OR social_has_permission(...,'manage_access')`;
-- DELETE was left on the generic family-member policy, so the row the household
-- used to hold someone at `read_only` could be removed by that same person.
--
-- This probe exists because AUTHZ-003 sat at ❌ FAIL for a full cycle on source
-- analysis alone — recorded honestly as "no live unauthorized request or SQL
-- mutation was performed". The escalation is asserted here by actually
-- performing it.
--
-- Judged on ROW COUNTS: a restrictive `using` clause makes the DELETE match
-- nothing and SUCCEED with zero rows, so an exception-only assertion would
-- report a boundary that is not there. The decisive assertion is not the row
-- count at all, though — it is that the restricted role SURVIVES the attempt.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-0000000a5001';
  own uuid := '00000000-0000-4000-8000-0000000a50a1';
  adu uuid := '00000000-0000-4000-8000-0000000a50a2';
  n        int;
  r        text;
  pub      boolean;
  conn     boolean;
  failures int := 0;
begin
  delete from public.social_access_permissions where family_id = fam;

  insert into auth.users (id, email) values
    (own, 'social-owner@example.com'), (adu, 'social-adult@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Social Access', own)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, own, 'Owner', 'parent', true),
    (fam, adu, 'Adult', 'adult',  true)
  on conflict do nothing;

  -- The household deliberately holds this adult at read_only. Without the row
  -- their family role would make them a marketing_manager.
  insert into public.social_access_permissions (family_id, user_id, social_role, status)
    values (fam, adu, 'read_only', 'active');

  -- ── as the restricted adult ──────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', adu::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.is_family_admin(fam) then
    raise exception 'CONTROL FAILED: acting as a family admin, so nothing below is a restriction';
  end if;

  -- 1. The restriction is in force to begin with. Without this the probe could
  --    pass against a database where the adult never had the permission at all.
  select public.social_role_for(fam)::text into r;
  select public.social_has_permission(fam, 'publish_posts') into pub;
  if r is distinct from 'read_only' or pub is distinct from false then
    raise warning 'CONTROL FAILED: the adult starts as % (publish_posts: %), not a restricted read_only', r, pub;
    failures := failures + 1;
  end if;

  -- 2. They cannot delete the row that restricts them.
  begin
    delete from public.social_access_permissions where family_id = fam and user_id = adu;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a restricted member deleted their own restriction (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Nor anyone else's, which reaches the same place by a longer road.
  begin
    delete from public.social_access_permissions where family_id = fam;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a restricted member deleted % access row(s) wholesale', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. The restriction still holds. This is the assertion that matters: the
  --    row counts above say the DELETE did nothing, and this says the
  --    PERMISSION did not grow back.
  select public.social_role_for(fam)::text into r;
  select public.social_has_permission(fam, 'publish_posts')    into pub;
  select public.social_has_permission(fam, 'connect_accounts') into conn;
  if r is distinct from 'read_only' then
    raise warning 'BREACH: the adult is now %, having been held at read_only', r;
    failures := failures + 1;
  end if;
  if pub or conn then
    raise warning 'BREACH: a restricted adult gained publish_posts=% connect_accounts=%', pub, conn;
    failures := failures + 1;
  end if;

  reset role;

  -- 5. An admin still administers access, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', own::text, true);
  set local role authenticated;
  begin
    if not public.is_family_admin(fam) then
      raise warning 'CONTROL FAILED: the owner is not a family admin, so the control below proves nothing';
      failures := failures + 1;
    end if;
    delete from public.social_access_permissions where family_id = fam and user_id = adu;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a family admin could not remove an access grant (rows: %)', n;
      failures := failures + 1;
    end if;
    insert into public.social_access_permissions (family_id, user_id, social_role, status)
      values (fam, adu, 'read_only', 'active');
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a family admin could not grant access (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a family admin could not administer access (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'social-restriction-removal: % assertion(s) failed', failures;
  end if;
  raise notice 'social-restriction-removal: OK — a restricted member cannot delete their way back to the fallback role';
end
$probe$;
