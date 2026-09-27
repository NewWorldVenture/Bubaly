-- 0420 — Only a released app installs. SRV-001 l8, re-derived from the source.
--
-- family_apps.status (0165) is 'published', 'beta', 'coming_soon' or
-- 'retired', and the App Store page draws no Install button for a coming-soon
-- app. That was the whole rule. installAppAction upserted whatever app id it
-- was handed, and 0165's install policies are is_family_member(family_id) and
-- nothing else, so any member could install a coming-soon or retired app —
-- through the action, or straight through /rest/v1 with their own JWT. The
-- installed card then showed "Unavailable" with no way to remove it.
--
-- The application half: installAppAction reads the app's status and refuses
-- anything but published or beta, and an INSTALLED app keeps its Remove
-- control whatever its status now says. This is the database half: two
-- RESTRICTIVE policies on family_app_installs, for INSERT (WITH CHECK) and
-- UPDATE (WITH CHECK), requiring the row's app to be published or beta.
-- `to authenticated, anon`, the roles that reach the table over the API.
--
-- DELETE is deliberately NOT guarded: removing an install must work whatever
-- the app's status became after it was installed. SELECT is unchanged.
-- Existing rows are left as they are: an install of an app that is now
-- coming-soon is a family's to remove, not the migration's.
--
-- Held by docs/audit/only-a-released-app-installs-check.sql.
-- Not applied to production by an agent; recorded in
-- docs/PENDING_PROD_MIGRATIONS.md for the owner.

do $$
begin
  if to_regclass('public.family_app_installs') is null or to_regclass('public.family_apps') is null then
    raise exception '0420: family_apps / family_app_installs are missing — 0165 has not been applied';
  end if;
end $$;

drop policy if exists family_app_installs_released_insert_guard on public.family_app_installs;
create policy family_app_installs_released_insert_guard on public.family_app_installs
  as restrictive for insert to authenticated, anon
  with check (exists (
    select 1 from public.family_apps a
     where a.id = app_id and a.status in ('published', 'beta')
  ));

drop policy if exists family_app_installs_released_update_guard on public.family_app_installs;
create policy family_app_installs_released_update_guard on public.family_app_installs
  as restrictive for update to authenticated, anon
  using (true)
  with check (exists (
    select 1 from public.family_apps a
     where a.id = app_id and a.status in ('published', 'beta')
  ));

do $$
begin
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'family_app_installs'
         and policyname in ('family_app_installs_released_insert_guard', 'family_app_installs_released_update_guard')
         and permissive = 'RESTRICTIVE') <> 2 then
    raise exception '0420: the two released-app guards are not both present and RESTRICTIVE';
  end if;
end $$;
