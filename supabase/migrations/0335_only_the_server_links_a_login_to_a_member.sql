-- Only the server links a login to a family member. (SEC-025)
--
-- `family_members.user_id` is what makes a member row somebody's membership.
-- fm_insert and fm_update let a family's parent or adult write member rows in
-- their own family — every column, user_id included — and every account is the
-- parent of the family it made. So any account could put a stranger's user id
-- into its own family:
--
--   * `profiles_select_self` shows co-members' profiles to each other, so the
--     stranger's email, full name, date of birth and phone became readable;
--   * the stranger's family switcher gained a family they never joined, and
--     `getUserContext` falls back to an unordered first membership when no
--     preference is stored.
--
-- A user id is not a secret: the feedback board shows every idea's author_id
-- and every vote's user_id to any signed-in account. Measured on the local
-- database as a signed-in parent (docs/audit/member-login-link-check.sql):
-- inserting a member row carrying another user's id succeeded, so did
-- relinking an existing row, and the other user's profile then read back; a
-- manager could also unlink a co-parent's login from their own row.
--
-- Nothing in the app writes user_id from the browser. Logins are linked by the
-- server with the service role (child logins, admin tools, onboarding) and by
-- the database's own SECURITY DEFINER functions (accept_invite,
-- handle_new_family, ensure_family_for_user). Inside those, current_user is the
-- function's owner; for a request through the API it is `authenticated` or
-- `anon`. So the rule is keyed on current_user, in a SECURITY INVOKER trigger
-- where it means the role running the statement — the opposite of 0334, where
-- the same test sat inside a definer function and refused everyone.
--
-- Adding, editing (name, role, birthday, contact) and removing members is
-- unchanged: none of those touch user_id.

create or replace function public.family_member_login_is_the_servers_to_link()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' and new.user_id is not null then
    raise exception 'A login joins a family through an invitation, not by being written onto a member.'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'A member''s login cannot be changed from here.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- A trigger function is not callable as an RPC, but keep it off the client
-- roles anyway so the default EXECUTE grant does not advertise it.
revoke all on function public.family_member_login_is_the_servers_to_link() from public, anon, authenticated;

drop trigger if exists trg_family_member_login_is_the_servers_to_link on public.family_members;
create trigger trg_family_member_login_is_the_servers_to_link
  before insert or update of user_id on public.family_members
  for each row execute function public.family_member_login_is_the_servers_to_link();

do $check$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.family_members'::regclass
       and tgname = 'trg_family_member_login_is_the_servers_to_link'
       and tgenabled <> 'D'
  ) then
    raise exception '0335: the member login trigger is missing or disabled';
  end if;
end
$check$;
