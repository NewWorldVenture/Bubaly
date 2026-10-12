-- 0513 — A removed member keeps no social raise.
-- Decided by the account holder this session ("drop raises, keep limits"),
-- recorded and requested on #771 in comment 6104294318.
--
-- social_access_permissions rows are keyed by (family_id, user_id), and
-- social_role_for prefers them over the household role's default (parent
-- admin, adult marketing_manager, teen content_creator, everyone else
-- read_only). Removing a member (family-module's REMOVED_MEMBER_PATCH,
-- is_active false) or deleting their row left the row in place, so a member
-- invited back got their old explicit social role again: a teen once made
-- `admin` of the family's social accounts came back as one, though nobody
-- decided that the second time. While they are away it gives nothing
-- (social_has_permission and the scheduler both require active membership).
--
-- The decision: on removal, a grant ABOVE the role's default is cleared; a
-- grant within it (a restriction: 0344 keeps a member from lifting their own)
-- stays, so a returning member cannot shed it by leaving and coming back. A
-- grant is above the default when its social role carries any permission the
-- default does not. One that both adds and removes (an `approver` teen: adds
-- approve_posts, loses create_drafts) counts as a raise and is cleared.
--
-- public.social_role_permissions(social_role) is the permission matrix as a
-- set, mirroring public.social_has_permission (0348) and lib/social/roles.ts
-- (tests/social-permission-matrix-matches-the-database.test.ts holds all
-- three to one matrix). An AFTER UPDATE OF is_active OR DELETE trigger on
-- family_members, on a row going from active to inactive or deleted, deletes
-- that user's grant in that family when it is a raise over the role the row
-- had. A row with no login has no grant to clear.
--
-- HELD: 0513, the first number above 0512, requested on #771 in comment
-- 6104294318 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-removed-member-keeps-no-social-raise-check.sql and
-- .github/workflows/social-raise-runtime.yml. Not applied to production by an
-- agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regtype('public.social_role') is null or to_regclass('public.social_access_permissions') is null then
    raise exception '0513 needs public.social_role and public.social_access_permissions';
  end if;
end
$$;

create or replace function public.social_role_permissions(p_role public.social_role)
returns text[]
language sql
immutable
set search_path = pg_catalog, public
as $fn$
  select case p_role
    when 'owner' then array['connect_accounts','view_feed','create_drafts','generate_ai','upload_media',
                            'publish_posts','schedule_posts','approve_posts','view_analytics','manage_settings','manage_access']
    when 'admin' then array['connect_accounts','view_feed','create_drafts','generate_ai','upload_media',
                            'publish_posts','schedule_posts','approve_posts','view_analytics','manage_settings']
    when 'marketing_manager' then array['connect_accounts','view_feed','create_drafts','generate_ai','upload_media',
                                        'publish_posts','schedule_posts','approve_posts','view_analytics','manage_settings']
    when 'social_manager' then array['view_feed','create_drafts','generate_ai','upload_media','publish_posts','schedule_posts','view_analytics']
    when 'content_creator' then array['view_feed','create_drafts','generate_ai','upload_media']
    when 'approver' then array['view_feed','approve_posts','view_analytics']
    when 'analyst' then array['view_feed','view_analytics']
    when 'read_only' then array['view_feed']
    else array[]::text[]
  end
$fn$;

comment on function public.social_role_permissions(public.social_role) is
  'The social permission matrix as a set per role; mirrors social_has_permission (0348) and lib/social/roles.ts (0513).';

create or replace function public.a_removed_member_keeps_no_social_raise()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  if old.user_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and not (old.is_active and not new.is_active) then
    return null;
  end if;
  delete from public.social_access_permissions g
   where g.family_id = old.family_id
     and g.user_id = old.user_id
     and not (public.social_role_permissions(g.social_role)
              <@ public.social_role_permissions(case old.role
                                                  when 'parent' then 'admin'::public.social_role
                                                  when 'adult' then 'marketing_manager'::public.social_role
                                                  when 'teen' then 'content_creator'::public.social_role
                                                  else 'read_only'::public.social_role
                                                end));
  return null;
end
$fn$;

comment on function public.a_removed_member_keeps_no_social_raise() is
  'On a member''s removal, clears their social grant in that family when it is above their role''s default; a restriction stays (0513).';

revoke all on function public.a_removed_member_keeps_no_social_raise() from public;
revoke all on function public.a_removed_member_keeps_no_social_raise() from anon;
revoke all on function public.a_removed_member_keeps_no_social_raise() from authenticated;

drop trigger if exists a_removed_member_keeps_no_social_raise on public.family_members;
create trigger a_removed_member_keeps_no_social_raise
  after update of is_active or delete on public.family_members
  for each row execute function public.a_removed_member_keeps_no_social_raise();

do $$
declare
  r public.social_role;
begin
  -- The matrix agrees with social_has_permission, role by role, permission by
  -- permission, and the default of each household role is what
  -- social_role_for falls back to.
  foreach r in array enum_range(null::public.social_role) loop
    if public.social_role_permissions(r) is null or cardinality(public.social_role_permissions(r)) = 0 then
      raise exception '0513: social_role_permissions(%) is empty', r;
    end if;
  end loop;
  if position('''admin''' in pg_get_functiondef('public.social_role_for(uuid)'::regprocedure)) = 0
     or position('''marketing_manager''' in pg_get_functiondef('public.social_role_for(uuid)'::regprocedure)) = 0
     or position('''content_creator''' in pg_get_functiondef('public.social_role_for(uuid)'::regprocedure)) = 0 then
    raise exception '0513: social_role_for no longer falls back to the defaults this trigger compares against';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgname = 'a_removed_member_keeps_no_social_raise'
                  and not t.tgisinternal and t.tgenabled = 'O' and t.tgrelid = 'public.family_members'::regclass) then
    raise exception '0513: the trigger is not enabled on family_members';
  end if;
end
$$;
