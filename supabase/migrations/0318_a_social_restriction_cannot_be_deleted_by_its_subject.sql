-- Bubaly :: 0318 - a social restriction cannot be deleted by the person it restricts
--
-- AUTHZ-003 (finalaudit.md), open since 2026-09-12 and held only by a no-SQL
-- rule in that cycle.
--
-- A family can pin a member to a narrower social role than their household
-- default: an adult set to `read_only` cannot connect accounts or publish.
-- The row that says so lives in `social_access_permissions`, and 0034 guards
-- its INSERT and UPDATE with "family admin, or holds manage_access". Its
-- DELETE was never tightened. The generic loop in 0034 gave every social_*
-- table the same four policies, and the later block that replaced two of them
-- for this table replaced INSERT and UPDATE only:
--
--     create policy social_access_permissions_delete ... for delete
--       using (public.is_family_member(family_id))
--
-- So the restricted adult deletes their own row, directly against the API.
-- `social_role_for` finds no explicit row and falls back to the household
-- default, which for an adult is `marketing_manager` — `connect_accounts` and
-- `publish_posts` included. The restriction was a suggestion.
--
-- Removing a restriction is exactly as privileged as changing one, so DELETE
-- takes the predicate UPDATE already has. The app never deletes these rows (it
-- only upserts), so no legitimate path narrows; an admin who wants to lift a
-- restriction still can.
--
-- Pinned by docs/audit/social-restriction-delete-check.sql.

do $$
begin
  if to_regclass('public.social_access_permissions') is null then
    return;
  end if;

  execute 'drop policy if exists social_access_permissions_delete on public.social_access_permissions';
  execute $p$
    create policy social_access_permissions_delete on public.social_access_permissions
      for delete
      using (public.is_family_admin(family_id)
             or public.social_has_permission(family_id, 'manage_access'))
  $p$;
end
$$;
