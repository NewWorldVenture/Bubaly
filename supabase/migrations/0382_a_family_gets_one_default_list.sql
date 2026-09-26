-- 0382_a_family_gets_one_default_list.sql
--
-- DATA-007's cross-client half: two first captures at once gave a family two
-- default lists.
--
-- Five writers get-or-create a family's default list the same way — read the
-- oldest open list, and insert one if there is none:
--
--   grocery_lists  lib/services/groceries ensureDefaultList (quick capture,
--                  the meal planner, the voice module), lib/assistant/tools,
--                  app/(app)/dashboard/moment-actions, recipes/vote/actions
--   todo_lists     lib/services/tasks ensureTodoList, lib/assistant/tools
--
-- Nothing serialises the read and the insert. Two members who each capture
-- their first "milk" in the same second both read "no list", both insert, and
-- the family has two "Groceries" lists. The shopping module opens the OLDEST,
-- so whatever landed on the newer one is on a list nobody is looking at, while
-- both captures reported "Added". Not lost data, but data put where it will not
-- be found — which reads the same to the person standing in the shop.
--
-- A unique index is the wrong tool, and that is why this was filed rather than
-- fixed with one: a family may legitimately keep many lists ("Costco",
-- "Party"), so "one open list per family" is not a rule of the data. The rule
-- is narrower — the GET-OR-CREATE of the DEFAULT list is one operation — and
-- that is a lock around the operation, not a constraint on the table.
--
-- So each is a function holding a per-family transaction advisory lock across
-- the read and the insert. The second caller waits, then its read (a new
-- statement under READ COMMITTED, so a new snapshot) sees the first caller's
-- committed list and returns it.
--
-- SECURITY INVOKER, deliberately. RLS still decides everything it decided
-- before: a non-member's read sees nothing and their insert is refused by the
-- table's own policy, and the service-role callers (the assistant's webhook)
-- still bypass it exactly as they did. The function adds ordering, not
-- authority. `created_by` is a parameter for the same reason — it is what the
-- callers already wrote, and grocery_lists names an auth user while todo_lists
-- names a family member (0002 vs 0015).
--
-- Callers fall back to the old read-then-insert when this function is absent,
-- because a deploy can precede its migration.
--
-- Idempotent.

create or replace function public.ensure_default_grocery_list(
  p_family_id  uuid,
  p_name       text,
  p_created_by uuid
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('default-grocery-list:' || p_family_id::text, 0));

  -- Both archive columns: only `archived_at` is ever written (the shopping
  -- module stamps it), so `is_archived` alone calls an archived list open.
  select id into v_id
    from public.grocery_lists
   where family_id = p_family_id
     and is_archived = false
     and archived_at is null
   order by created_at asc, id asc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.grocery_lists (family_id, name, created_by)
  values (p_family_id, coalesce(nullif(btrim(p_name), ''), 'Groceries'), p_created_by)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.ensure_default_grocery_list(uuid, text, uuid) is
  'Get-or-create the family''s default grocery list as ONE operation, serialised per family by an advisory lock, so two first captures at once cannot create two lists. SECURITY INVOKER: RLS decides access exactly as before. DATA-007.';

create or replace function public.ensure_default_todo_list(
  p_family_id  uuid,
  p_name       text,
  p_match_name boolean,
  p_created_by uuid
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_name text := coalesce(nullif(btrim(p_name), ''), 'Tasks');
  v_id   uuid;
begin
  -- Keyed on the name too when the caller asked for a NAMED list, so "School"
  -- and "Chores" created at the same moment do not wait on each other.
  perform pg_advisory_xact_lock(hashtextextended(
    'default-todo-list:' || p_family_id::text || ':' || case when p_match_name then lower(v_name) else '' end, 0));

  select id into v_id
    from public.todo_lists
   where family_id = p_family_id
     and archived_at is null
     and (not p_match_name or name = v_name)
   order by created_at asc, id asc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.todo_lists (family_id, name, created_by)
  values (p_family_id, v_name, p_created_by)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.ensure_default_todo_list(uuid, text, boolean, uuid) is
  'Get-or-create a family''s to-do list (the oldest open one, or the oldest open one with that name) as ONE operation, serialised per family by an advisory lock. SECURITY INVOKER: RLS decides access exactly as before. DATA-007.';

revoke all on function public.ensure_default_grocery_list(uuid, text, uuid) from public, anon;
revoke all on function public.ensure_default_todo_list(uuid, text, boolean, uuid) from public, anon;
grant execute on function public.ensure_default_grocery_list(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.ensure_default_todo_list(uuid, text, boolean, uuid) to authenticated, service_role;
