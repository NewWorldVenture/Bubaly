-- AUTHZ-003: can a member lift their own social restriction by deleting it?
--
-- An adult pinned to `read_only` must not be able to delete that row and fall
-- back to their household default (`marketing_manager`: connect + publish).
-- 0034 guarded INSERT/UPDATE on social_access_permissions and left DELETE on
-- the generic `is_family_member` policy; 0318 gives DELETE the UPDATE
-- predicate. Controls: the restriction really denies publish while it stands,
-- and a parent (family admin) can still remove it.
--
-- Judged on row counts: a refused DELETE raises nothing, it matches zero rows.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam   uuid := '00000000-0000-4000-8000-00000000ee01';
  uPar  uuid := '00000000-0000-4000-8000-00000000ee0a';
  uAdl  uuid := '00000000-0000-4000-8000-00000000ee0b';
  n int; role_now text; can_publish boolean; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'social-parent@example.com'), (uAdl, 'social-adult@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Social family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uAdl, 'Restricted adult', 'adult', true);
  insert into public.social_access_permissions (family_id, user_id, social_role, status)
    values (fam, uAdl, 'read_only', 'active');

  -- Act as the restricted adult.
  perform set_config('request.jwt.claim.sub', uAdl::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uAdl, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- Control: the restriction is in force.
  role_now := public.social_role_for(fam)::text;
  can_publish := public.social_has_permission(fam, 'publish_posts');
  if role_now <> 'read_only' or can_publish then
    raise warning 'CONTROL FAILED: the restriction is not in force (role %, publish %)', role_now, can_publish;
    failures := failures + 1;
  end if;

  -- The finding: delete it.
  delete from public.social_access_permissions where family_id = fam and user_id = uAdl;
  get diagnostics n = row_count;
  if n <> 0 then
    raise warning 'BREACH: a restricted member deleted their own social restriction (rows: %)', n;
    failures := failures + 1;
  end if;
  role_now := public.social_role_for(fam)::text;
  can_publish := public.social_has_permission(fam, 'publish_posts');
  if role_now <> 'read_only' or can_publish then
    raise warning 'BREACH: after the delete the member resolves to % (publish %)', role_now, can_publish;
    failures := failures + 1;
  end if;
  reset role;

  -- Control: a parent can still lift it.
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.social_access_permissions where family_id = fam and user_id = uAdl;
  get diagnostics n = row_count;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a parent could not remove the restriction (rows: %)', n;
    failures := failures + 1;
  end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uAdl);

  if failures > 0 then
    raise exception 'social-restriction-delete-check: % failure(s)', failures;
  end if;
end
$probe$;
