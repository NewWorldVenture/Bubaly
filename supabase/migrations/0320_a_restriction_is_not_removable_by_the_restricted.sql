-- Bubaly :: 0320 - a restriction is not removable by the person it restricts
--
-- This closes AUTHZ-003, open as ❌ FAIL (Critical) since it was found by
-- source analysis. The finding was recorded with the honest caveat that "no
-- live unauthorized request or SQL mutation was performed", and repair was
-- blocked by that cycle's standing no-SQL boundary. It has now been reproduced
-- by execution.
--
-- `social_access_permissions` grants a household member an explicit social
-- role. `social_role_for` reads it, and falls back to the member's family role
-- when there is no row:
--
--   select coalesce(
--     (select social_role from public.social_access_permissions
--        where family_id = p_family_id and user_id = auth.uid() and status = 'active' limit 1),
--     (select case fm.role
--               when 'parent' then 'admin' when 'adult' then 'marketing_manager'
--               when 'teen' then 'content_creator' else 'read_only' end ...))
--
-- A `coalesce` over a deletable row is a privilege that grows back. The three
-- granular policies added later tightened INSERT and UPDATE to
-- `is_family_admin(family_id) OR social_has_permission(family_id,'manage_access')`
-- and left DELETE on the generic family-member policy:
--
--   social_access_permissions_insert  INSERT  with check: is_family_admin(...) OR social_has_permission(...)
--   social_access_permissions_update  UPDATE  using/check: is_family_admin(...) OR social_has_permission(...)
--   social_access_permissions_delete  DELETE  using:      is_family_member(family_id)   ← the hole
--
-- so the row could not be created or edited by the person it restricts, and
-- could be deleted by them. The restriction was the only thing standing between
-- them and the fallback, and removing it was the one verb left open.
--
-- ── measured, acting as the restricted adult ────────────────────────────────
--
--   BEFORE: role=read_only         publish_posts=f
--   DELETE of own restriction affected 1 row(s)
--   AFTER:  role=marketing_manager publish_posts=t connect_accounts=t
--
-- The household deliberately held this adult at `read_only`. One DELETE later
-- they may publish to, and connect, the family's social accounts.
--
-- The guard matches the two verbs that were already right, rather than
-- inventing a third rule: access is administered by a family admin or by
-- someone holding `manage_access`. `social_has_permission` grants that only to
-- `owner` and `admin` — every other social role carries an enumerated list that
-- does not include it — so this does not quietly widen who may administer
-- access.
--
-- A member deleting their OWN row is refused along with everyone else's. There
-- is no "but it is mine" carve-out here, precisely because the row being one's
-- own is what makes deleting it an escalation.
--
-- Restrictive guard, 0254's mechanism: it ANDs with the union of the permissive
-- policies, so the generic family-member DELETE policy — and any future one,
-- whatever it is called — cannot grant past it.

do $$
begin
  if to_regclass('public.social_access_permissions') is not null then
    drop policy if exists social_access_permissions_delete_guard on public.social_access_permissions;
    create policy social_access_permissions_delete_guard on public.social_access_permissions
      as restrictive for delete to authenticated
      using (
        public.is_family_admin(family_id)
        or public.social_has_permission(family_id, 'manage_access')
      );
  end if;
end
$$;

comment on table public.social_access_permissions is
  'Explicit per-member social role. social_role_for coalesces this row with a fallback derived from the family role, so deleting the row RESTORES the broader permission — which is why DELETE is administered by a family admin or manage_access holder, exactly like INSERT and UPDATE, with no carve-out for deleting one''s own restriction (0320, closing AUTHZ-003).';
