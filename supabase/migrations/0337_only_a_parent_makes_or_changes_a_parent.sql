-- Only a parent makes, changes or removes a parent. (SEC-026)
--
-- The role model (lib/constants/roles.ts): a parent has "full control:
-- members, billing, and all household data"; an adult "manages shared
-- household data and approves chores". Parent is not an invitable role, and
-- 0298 stopped an invitation being rewritten into one
-- (docs/audit/invite-role-escalation-check.sql).
--
-- But fm_insert, fm_update and fm_delete gate on can_manage_family, which is
-- true for adults, and none of them limits `role`. Measured on the local
-- database, as an invited adult (docs/audit/parent-role-is-the-parents-check.sql):
-- promoting themselves to parent, adding a new parent, demoting the family's
-- parent to child, deactivating the parent, deleting the parent's row and
-- editing it all succeeded, and after the self-promotion the adult passed
-- is_family_admin, which is the whole of families_delete. The family module
-- offers this in its UI: every member card has Edit and Remove for any
-- manager, and the role picker includes Parent.
--
-- The rule, for a write made through the API (current_user `authenticated` or
-- `anon`; the server's service role and the database's own definer functions
-- run as other roles and are not affected):
--
--   * a parent of the family may do what the policies already allow;
--   * anyone else may not touch a row that is a parent's (change, deactivate,
--     delete), and may not make a row a parent's — unless the family has no
--     active parent at all, so a family whose only parent stepped down is not
--     left with nobody who can do parent-only things.
--
-- Adults keep managing everyone else: adding, editing and removing children,
-- teens, caregivers, guests and other adults, and changing their own role
-- downward.

create or replace function public.family_parent_role_is_the_parents()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_family uuid;
begin
  if current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.role = 'parent' and not public.is_family_admin(old.family_id) then
      raise exception 'Only a parent can remove a parent.' using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.role = 'parent' and not public.is_family_admin(old.family_id) then
    raise exception 'Only a parent can change a parent.' using errcode = 'insufficient_privilege';
  end if;

  if new.role = 'parent' and (tg_op = 'INSERT' or old.role is distinct from 'parent' or old.family_id is distinct from new.family_id) then
    v_family := new.family_id;
    if not public.is_family_admin(v_family)
       and exists (
         select 1 from public.family_members m
          where m.family_id = v_family and m.role = 'parent' and m.is_active
            and m.id is distinct from new.id
       ) then
      raise exception 'Only a parent can make someone a parent.' using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.family_parent_role_is_the_parents() from public, anon, authenticated;

drop trigger if exists trg_family_parent_role_is_the_parents on public.family_members;
create trigger trg_family_parent_role_is_the_parents
  before insert or update or delete on public.family_members
  for each row execute function public.family_parent_role_is_the_parents();

do $check$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.family_members'::regclass
       and tgname = 'trg_family_parent_role_is_the_parents'
       and tgenabled <> 'D'
  ) then
    raise exception '0337: the parent-role trigger is missing or disabled';
  end if;
end
$check$;
