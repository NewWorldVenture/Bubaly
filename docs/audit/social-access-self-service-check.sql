-- ── 0317: a social restriction is not self-service ──────────────────────────
--
-- social_access_permissions decides who may post to the family's connected
-- social accounts. 0034 gated INSERT and UPDATE on
-- `is_family_admin(family_id) or social_has_permission(family_id,'manage_access')`
-- and left DELETE as `is_family_member(family_id)` — which is the way around
-- both, because social_role_for() COALESCEs an explicit row over a default
-- derived from the family role. Delete the row that restricts you and you fall
-- back UP.
--
-- Measured before 0317, as an `adult` deliberately set to `read_only`:
--   D's social role now: marketing_manager   can D publish? t
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/social-access-self-service-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
-- Audit C1-S6-11.
do $$
declare
  fam uuid := 'f0317000-0000-4000-8000-00000000fa01';
  up  uuid := 'f0317000-0000-4000-8000-00000000c001';  -- parent, the grantor
  ud  uuid := 'f0317000-0000-4000-8000-00000000c002';  -- adult, restricted to read_only
  n int; role_now text;
begin
  insert into public.families (id, name) values (fam, '0317 social access') on conflict do nothing;
  insert into auth.users (id, email) values
    (up, 'p0317@example.test'), (ud, 'd0317@example.test') on conflict do nothing;
  delete from public.social_access_permissions where family_id = fam;
  delete from public.family_members where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, up, 'Owner P', 'parent', true),
    (fam, ud, 'Demoted D', 'adult', true);
  -- The restriction matters BECAUSE it is below the family default: an `adult`
  -- with no row resolves to marketing_manager, which may publish.
  insert into public.social_access_permissions (family_id, user_id, social_role, status, granted_by, created_by)
    values (fam, ud, 'read_only', 'active', up, up);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', ud::text, true);
  if auth.uid() is distinct from ud then
    raise exception '0317: impersonation failed — auth.uid() is %, expected the restricted member', auth.uid();
  end if;

  -- The premise. If this ever stops holding, the rest of the probe is testing
  -- a restriction that was never restricting anything.
  if public.social_has_permission(fam, 'publish_posts') then
    raise exception '0317: a read_only social role may publish — the fixture is not restricting anyone';
  end if;

  delete from public.social_access_permissions where family_id = fam and user_id = ud;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0317: a member deleted the row restricting them (% row(s))', n;
  end if;

  -- And the consequence, asserted separately: the delete being refused is only
  -- interesting because of what the fallback would have granted.
  select public.social_role_for(fam)::text into role_now;
  if role_now is distinct from 'read_only' then
    raise exception '0317: the restricted member now resolves to % — they fell back up', role_now;
  end if;
  if public.social_has_permission(fam, 'publish_posts')
     or public.social_has_permission(fam, 'manage_settings')
     or public.social_has_permission(fam, 'connect_accounts') then
    raise exception '0317: the restricted member can publish, manage settings or connect accounts';
  end if;

  -- Nor may they remove somebody else's grant.
  delete from public.social_access_permissions where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0317: a restricted member cleared % access row(s) for the whole family', n;
  end if;

  -- ── What must still work ──────────────────────────────────────────────────
  -- The family's admin revokes by deleting the row.
  perform set_config('request.jwt.claim.sub', up::text, true);
  if not public.is_family_admin(fam) then
    raise exception '0317: the fixture parent is not a family admin — the next assertion proves nothing';
  end if;
  delete from public.social_access_permissions where family_id = fam and user_id = ud;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0317: a family ADMIN could not remove an access row (% row(s)) — the fix went too far', n;
  end if;

  reset role;
  raise notice '0317 OK: only the adults who manage social access may remove a row, and a restricted member stays restricted';
end $$;
