-- ── A restriction may not be removable by the person it restricts ────────────
--
-- social_access_permissions is an OVERRIDE table. lib/social/access.ts resolves
-- the caller's social role as "an explicit row wins; otherwise fall back to a
-- default derived from their household member role", and those defaults
-- (lib/social/roles.ts) are:
--
--   parent -> admin              adult -> marketing_manager
--   teen   -> content_creator    everyone else -> read_only
--
-- So an override is the mechanism for holding someone BELOW their default —
-- an adult pinned to read_only, a teen pinned to read_only. That is the whole
-- point of having the table.
--
-- 0034 gated who may create or change such a row:
--
--   insert / update : is_family_admin(family_id) OR social_has_permission(family_id,'manage_access')
--   delete          : is_family_member(family_id)          <-- any member
--
-- The asymmetry is the defect. Granting or editing a restriction took admin,
-- while REMOVING one took only membership, and removing the row restores the
-- higher default. A member restricted to read_only could therefore lift their
-- own restriction: an adult back to marketing_manager — which carries
-- publish_posts, schedule_posts, approve_posts and manage_settings — and so
-- back to posting on the family's connected social accounts.
--
-- No application code deletes from this table, which is why it was not visible
-- from the app. It did not need to: every family member holds a JWT and can
-- issue the delete straight to PostgREST, and access.ts says so itself —
-- "RLS is the backstop".
--
-- Delete now matches insert and update exactly. Nothing else about the table
-- changes: members keep SELECT, and an admin can still remove an override.
drop policy if exists social_access_permissions_delete on public.social_access_permissions;
create policy social_access_permissions_delete on public.social_access_permissions
  for delete to authenticated
  using (
    public.is_family_admin(family_id)
    or public.social_has_permission(family_id, 'manage_access')
  );
