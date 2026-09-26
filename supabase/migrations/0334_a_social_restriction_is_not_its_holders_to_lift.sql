-- 0334 — A social restriction is not its holder's to lift.
--
-- A social role is stored as one row per (family, user) in social_access_permissions,
-- and with no row social_role_for falls back to a default by household role:
--
--   parent → admin     adult → marketing_manager     teen → content_creator
--
-- So the ROW is what makes a restriction real. 0034 narrowed INSERT and UPDATE to
-- `is_family_admin OR social_has_permission('manage_access')`, and left DELETE on the
-- generic `is_family_member(family_id)`. Measured as a real `authenticated` adult on a
-- full replay, before this migration:
--
--   delete from social_access_permissions where id = <own read_only row>;  -> DELETE 1
--   select social_role_for(fam);                                   -> marketing_manager
--
-- A member a parent had deliberately set to read_only removed the restriction and
-- fell back to connecting accounts and publishing as the family. The DELETE policy
-- never examined `user_id` either, so any member could delete ANY member's row —
-- lifting a teen's restriction, or a sibling's.
--
-- WHY THIS BREAKS NOTHING. No application code deletes from this table at all. The
-- only writer is the manager-gated upsert in app/(app)/dashboard/social/actions.ts,
-- and the only other references are reads. DELETE now requires exactly the authority
-- INSERT and UPDATE already did, and `manage_access` belongs only to owner and admin,
-- so in effect a revoke is a parent's.
--
-- A RESTRICTIVE delete guard is ANDed with every permissive policy, so a stray one
-- added later cannot reopen this alone, and any other permissive DELETE policy is
-- swept by shape rather than by name. social_has_permission is SECURITY DEFINER, so
-- reading this table from inside its own policy does not recurse through RLS; the
-- existing INSERT and UPDATE policies already rely on that.
--
-- Proved by docs/audit/social-access-delete-boundary-check.sql, which fails before
-- this migration with "an adult deleted their own read_only restriction" and passes
-- after it, including a parent's revoke and every member's read.
--
-- Agents must NOT apply this to production. It is committed for an operator to apply
-- with the other pending migrations.

do $$
declare
  pol       record;
  swept     int := 0;
  remaining int;
  authority text := '(public.is_family_admin(family_id) or public.social_has_permission(family_id, ''manage_access''))';
begin
  if to_regclass('public.social_access_permissions') is null then
    raise notice '0334: social_access_permissions absent — nothing to do';
    return;
  end if;

  drop policy if exists social_access_permissions_delete on public.social_access_permissions;
  execute 'create policy social_access_permissions_delete on public.social_access_permissions '
       || 'for delete to authenticated using ' || authority;

  drop policy if exists social_access_permissions_delete_guard on public.social_access_permissions;
  execute 'create policy social_access_permissions_delete_guard on public.social_access_permissions '
       || 'as restrictive for delete to authenticated using ' || authority;

  -- By SHAPE: any other permissive policy that can delete a row, whatever it is called.
  for pol in
    select p.polname
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'social_access_permissions'
      and p.polpermissive
      and p.polcmd in ('d', '*')
      and p.polname <> 'social_access_permissions_delete'
  loop
    execute format('drop policy if exists %I on public.social_access_permissions', pol.polname);
    swept := swept + 1;
    raise notice '0334: dropped permissive delete policy social_access_permissions.%', pol.polname;
  end loop;

  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'social_access_permissions'
    and p.polpermissive
    and p.polcmd in ('d', '*')
    and pg_get_expr(p.polqual, p.polrelid) !~ '(is_family_admin|manage_access)';
  if remaining <> 0 then
    raise exception '0334: % permissive delete policy(ies) on social_access_permissions still do not require manage_access', remaining;
  end if;

  raise notice '0334: social role deletes require manage_access (% stray policy(ies) swept)', swept;
end $$;
