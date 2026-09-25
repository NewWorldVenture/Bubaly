-- Removing a member ends their profile's visibility to the family. (PRIV-002)
--
-- `profiles_select_self` (0118) lets co-members read each other's profiles:
--
--   exists (select 1 from family_members me
--             join family_members them on them.family_id = me.family_id
--            where me.user_id = auth.uid() and them.user_id = profiles.id)
--
-- Neither side checks `is_active`. Removing a member sets `is_active = false`
-- and keeps the row (for history), and `fm_select` still shows that row to the
-- family, so the family went on reading the removed person's profile — email,
-- full name, date of birth, phone — including whatever they change it to after
-- they left. Measured on the local database: a parent reads a removed adult's
-- profile and gets their current phone number. (The removed person is already
-- shut out the other way: `fm_select` hides the family's rows from them.)
--
-- Every other family read ends at removal: `is_family_member` and
-- `can_manage_family` both require `is_active`. This brings the one policy
-- that exposes a person rather than family data into line. No app path reads
-- another user's profile through RLS (the few that need one use the service
-- role), so nothing that is meant to work changes.

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select
  using (
    id = auth.uid()
    or exists (
      select 1 from public.family_members me
      join public.family_members them on them.family_id = me.family_id
      where me.user_id = auth.uid() and me.is_active
        and them.user_id = public.profiles.id and them.is_active
    )
  );

do $check$
declare
  qual text;
begin
  select pg_get_expr(polqual, polrelid) into qual
    from pg_policy
   where polrelid = 'public.profiles'::regclass and polname = 'profiles_select_self';
  if qual is null then
    raise exception '0336: profiles_select_self is missing';
  end if;
  if qual !~ 'me\.is_active' or qual !~ 'them\.is_active' then
    raise exception '0336: profiles_select_self does not require both memberships to be active: %', qual;
  end if;
end
$check$;
