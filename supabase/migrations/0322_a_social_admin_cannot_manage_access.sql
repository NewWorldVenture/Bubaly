-- Bubaly :: 0322 - a social admin cannot hand out social access
--
-- lib/social/roles.ts states the social role matrix, and the database mirrors
-- it in social_has_permission (0034, "mirrored from lib/social/roles.ts"). They
-- disagree on one cell, and it is the one that matters:
--
--     JS   admin: ALL.filter((p) => p !== 'manage_access')
--     SQL  when 'admin' then true
--
-- `manage_access` is exactly what the social_access_permissions write policies
-- check (INSERT/UPDATE since 0034, DELETE since 0318): is_family_admin OR
-- social_has_permission(family, 'manage_access'). So a member a parent made a
-- social `admin` — an adult, a teen who runs the family account — could, directly
-- against the API, rewrite anyone's social role, including promoting themselves
-- to `owner`, which the app refuses and the role's own description ("Full
-- operational control over accounts, content, publishing, and settings") does
-- not include. Parents are unaffected: they pass the policies through
-- is_family_admin.
--
-- The function is redefined with admin = everything except manage_access, as
-- the JavaScript says. Every other role and the active-membership prerequisite
-- are unchanged. Pinned by docs/audit/social-permission-matrix-check.sql.

create or replace function public.social_has_permission(p_family_id uuid, p_permission text)
returns boolean language sql security definer stable set search_path = public as $$
  with role_cte as (select public.social_role_for(p_family_id) as r)
  select public.is_family_member(p_family_id) and (
    select case (select r from role_cte)
      when 'owner' then true
      when 'admin' then p_permission <> 'manage_access'
      when 'marketing_manager' then p_permission in
        ('connect_accounts','view_feed','create_drafts','generate_ai','upload_media',
         'publish_posts','schedule_posts','approve_posts','view_analytics','manage_settings')
      when 'social_manager' then p_permission in
        ('view_feed','create_drafts','generate_ai','upload_media','publish_posts','schedule_posts','view_analytics')
      when 'content_creator' then p_permission in
        ('view_feed','create_drafts','generate_ai','upload_media')
      when 'approver' then p_permission in ('view_feed','approve_posts','view_analytics')
      when 'analyst' then p_permission in ('view_feed','view_analytics')
      when 'read_only' then p_permission in ('view_feed')
      else false
    end
  );
$$;
