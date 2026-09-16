-- Bubaly :: 0312 A social restriction is not self-service
-- ----------------------------------------------------------------------------
-- `social_access_permissions` is the table that says who may post to the
-- family's connected social accounts. 0034 guarded it carefully on the way in
-- and on the way through:
--
--   social_access_permissions_insert  with check (is_family_admin(family_id)
--                                       or social_has_permission(family_id,'manage_access'))
--   social_access_permissions_update  using/with check (same)
--   social_access_permissions_delete  using (is_family_member(family_id))
--
-- and the third one is the way around the first two, because of how the role is
-- resolved. `social_role_for()` COALESCEs: an explicit active row wins, and with
-- no row it falls back to a default derived from the family role —
-- parent → admin, adult → marketing_manager, teen → content_creator,
-- everyone else → read_only.
--
-- So an explicit row that RESTRICTS someone below their family default is
-- deleted by the very person it restricts, and they fall back UP. Measured on
-- the replayed schema, as an `adult` the family had deliberately set to
-- `read_only`:
--
--   D's social role while restricted: read_only
--     can D publish? f       can D manage settings? f
--   D deleted their own restriction: 1 row(s)
--   D's social role now: marketing_manager
--     can D publish? t       can D manage settings? t
--
-- `publish_posts` on a connected account is not an in-app permission; it writes
-- to the family's real audience. `manage_settings` and `connect_accounts` come
-- with it. The same delete also works in the other direction — any member could
-- remove somebody else's grant — but the escalation is the sharp end.
--
-- NOTHING IN THE TREE DELETES FROM THIS TABLE. `grantAccessAction`
-- (app/(app)/dashboard/social/actions.ts:307) upserts behind
-- `requireSocialPermission(fid,'manage_access')`, and revocation is a `status`
-- change, which the UPDATE policy already guards. The DELETE policy granted a
-- capability no feature uses and every other policy on the table exists to
-- prevent.
--
-- The fix is to write the same predicate the other two carry, so the three verbs
-- agree about who decides.
--
-- Additive to the data; the policy is replaced by name, so it is idempotent.
-- Asserted by docs/audit/social-access-self-service-check.sql, which CI replays
-- with the rest of docs/audit/*-check.sql.

drop policy if exists social_access_permissions_delete on public.social_access_permissions;
create policy social_access_permissions_delete on public.social_access_permissions
  for delete using (
    public.is_family_admin(family_id)
    or public.social_has_permission(family_id, 'manage_access')
  );
