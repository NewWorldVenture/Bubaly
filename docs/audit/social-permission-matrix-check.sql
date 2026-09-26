-- The database's social permission check, against the app's role matrix.
--
-- 1. A member a parent made a social `admin` must not be able to manage social
--    access (lib/social/roles.ts: admin = ALL except manage_access). Before 0322
--    the SQL granted admin everything, so that member could rewrite anyone's
--    social role, and promote themselves to owner, directly against the API.
-- 2. AUTHZ-002's database half: an explicit role grants nothing to a member who
--    is no longer active, and a read_only restriction really restricts.
-- Controls: the admin keeps operational permissions (publish); a parent can
-- still manage access.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-00000000ed51';
  uPar   uuid := '00000000-0000-4000-8000-00000000ed5a';
  uAdmin uuid := '00000000-0000-4000-8000-00000000ed5b';
  uTeen  uuid := '00000000-0000-4000-8000-00000000ed5c';
  uGone  uuid := '00000000-0000-4000-8000-00000000ed5d';
  n int; ok boolean; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'matrix-parent@example.com'), (uAdmin, 'matrix-admin@example.com'),
    (uTeen, 'matrix-teen@example.com'), (uGone, 'matrix-gone@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Matrix family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, uAdmin, 'Adult admin', 'adult', true),
    (fam, uTeen, 'Teen', 'teen', true),
    (fam, uGone, 'Former member', 'adult', false);
  insert into public.social_access_permissions (family_id, user_id, social_role, status) values
    (fam, uAdmin, 'admin', 'active'),
    (fam, uTeen, 'read_only', 'active'),
    (fam, uGone, 'owner', 'active');

  -- ── the social admin ──────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uAdmin::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if not public.social_has_permission(fam, 'publish_posts') then
    raise warning 'CONTROL FAILED: a social admin cannot publish'; failures := failures + 1;
  end if;
  if public.social_has_permission(fam, 'manage_access') then
    raise warning 'BREACH: a social admin holds manage_access (the app says admin excludes it)'; failures := failures + 1;
  end if;
  update public.social_access_permissions set social_role = 'owner' where family_id = fam and user_id = uAdmin;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a social admin promoted themselves to owner (rows: %)', n; failures := failures + 1; end if;
  update public.social_access_permissions set social_role = 'admin' where family_id = fam and user_id = uTeen;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a social admin rewrote another member''s social role (rows: %)', n; failures := failures + 1; end if;
  reset role;

  -- ── AUTHZ-002, database half ─────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uTeen::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uTeen, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.social_has_permission(fam, 'publish_posts') or not public.social_has_permission(fam, 'view_feed') then
    raise warning 'BREACH: read_only does not restrict to view_feed'; failures := failures + 1;
  end if;
  reset role;

  perform set_config('request.jwt.claim.sub', uGone::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uGone, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.social_has_permission(fam, 'view_feed') or public.social_has_permission(fam, 'manage_access') then
    raise warning 'BREACH: an explicit owner row still grants access to a member who is no longer active'; failures := failures + 1;
  end if;
  reset role;

  -- ── the parent (control) ─────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.social_access_permissions set social_role = 'content_creator' where family_id = fam and user_id = uTeen;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not manage social access (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uAdmin, uTeen, uGone);

  if failures > 0 then
    raise exception 'social-permission-matrix-check: % failure(s)', failures;
  end if;
end
$probe$;
