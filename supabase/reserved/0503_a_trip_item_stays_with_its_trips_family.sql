-- 0503 — A trip item stays with its trip's family.
-- A trip item leaves its family only through managers of both families, and
-- names only its own family's trip. Found 2026-10-10 (the 6095230993 census)
-- and re-measured on a replay of every runnable migration at main 3e2518317,
-- with every held migration through 0502 applied.
--
-- trip_items carries a manager-only delete (RESTRICTIVE trip_items_manager_
-- delete_guard) and trip_item_content_guard, which lets only a family manager
-- change an item's content, family included. But the guard authorises with
-- can_manage_family(NEW.family_id) only, and the table's update policy is
-- is_family_member(family_id) on both halves. So a person who is not a manager
-- of the trip's family but is a parent of another family moves the item there.
-- Measured as a teen of Trip House who is a parent of their own house, under
-- PostgREST's role:
--
--   delete the packing item                              0 rows (manager-only)
--   rewrite its label in place                           refused (the guard)
--   update set family_id = <own house>, label = '…'      1 row
--   update set family_id = <own house>, trip_id = <own trip>   1 row
--
-- Trip House then holds 0 items: a delete, and a rewrite, the teen could not do
-- directly. Binding trip_id alone (0311) is not enough, as the last line shows:
-- the move simply takes a trip of the new family with it.
--
-- So this adds two things to trip_items:
--
--   1. trip_item_family_change_guard, BEFORE UPDATE OF family_id: a signed-in
--      caller changes an item's family only if they manage BOTH the family it
--      leaves and the family it joins (42501, its own sentence), the shape
--      home_asset_manager_field_guard already has. The service role and
--      session-less writers are exempt, as in every guard of this family.
--   2. 0311's own reference_shares_family('trip_id', 'trips'), BEFORE INSERT OR
--      UPDATE OF trip_id, family_id, exactly as 0497 and 0501 wire it: an item
--      names only its own family's trip, so even a manager of both families
--      moves an item together with a trip reference in the new family, and an
--      item cannot be filed in one family against another family's trip.
--
-- Named so the move guard runs before the binding (row triggers on one event
-- fire in name order): a non-manager's move is refused with the move sentence
-- whatever trip it names. Nothing in the application moves a trip item or names
-- another family's trip; ticking an item done still lands for every member.
--
-- Recorded, not changed (the 6097700163 census): the other seven guards that
-- ask only the new family are already bounded on their tables. chores (0502)
-- refuses a non-manager's move; reward_redemptions (0500) freezes family_id;
-- chore_assignments is 0311-bound; economy_redemptions and invest_orders are
-- manager-only to update on both halves; chore_disputes and chore_submissions
-- move only the mover's own row; family_playbook_suggestions hides a sensitive
-- row from a non-manager. trips are manager-only to update on both halves
-- (trips_manager_update_guard). trip_items.assignee_id is set only by a
-- manager (the content guard), so it is not bound here.
--
-- HELD: 0503, the first number above 0502, requested on #771 in comments
-- 6097696125 and 6097700163 and not yet confirmed. It stays in
-- supabase/reserved/ until every number below it has landed. Proven by
-- docs/audit/reserved/a-trip-item-stays-with-its-trips-family-check.sql and
-- .github/workflows/trip-item-family-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regprocedure('public.reference_shares_family()') is null then
    raise exception '0503 needs reference_shares_family() from 0311';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception '0503 needs public.can_manage_family(uuid)';
  end if;
  if to_regclass('public.trip_items') is null or to_regclass('public.trips') is null then
    raise exception '0503 needs public.trip_items and public.trips';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'trip_items' and column_name = 'family_id')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'trip_items' and column_name = 'trip_id') then
    raise exception '0503: trip_items.family_id or trip_items.trip_id does not exist';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'trips' and column_name = 'family_id') then
    raise exception '0503: parent trips.family_id does not exist, so the binding on trip_items.trip_id would raise 42703 on every authenticated write';
  end if;
end
$$;

create or replace function public.trip_item_family_change_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.family_id is not distinct from old.family_id then
    return new;
  end if;
  -- The trusted server (service role, or a migration/seed with no session).
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null then
    return new;
  end if;
  -- A manager of the family the item leaves AND of the family it joins.
  if public.can_manage_family(old.family_id) and public.can_manage_family(new.family_id) then
    return new;
  end if;
  raise exception 'A trip item can only be moved to another family by a manager of both families'
    using errcode = '42501';
end
$$;

comment on function public.trip_item_family_change_guard() is
  'Refuses (42501) a signed-in caller moving a trip item to another family unless they manage both the family it leaves and the family it joins; trip_item_content_guard asks only the new family, so a non-manager of the trip''s family who is a parent elsewhere moved items out (0503). The service role and session-less writers are exempt.';

revoke all on function public.trip_item_family_change_guard() from public;

drop trigger if exists trg_trip_item_family_change_guard on public.trip_items;
create trigger trg_trip_item_family_change_guard
  before update of family_id on public.trip_items
  for each row execute function public.trip_item_family_change_guard();

drop trigger if exists trg_trip_items_trip_id_family on public.trip_items;
create trigger trg_trip_items_trip_id_family
  before insert or update of trip_id, family_id on public.trip_items
  for each row execute function public.reference_shares_family('trip_id', 'trips');

do $$
begin
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.trip_items'::regclass
       and t.tgname = 'trg_trip_item_family_change_guard'
       and t.tgfoid = 'public.trip_item_family_change_guard()'::regprocedure
       and t.tgenabled <> 'D'
       and (t.tgtype & 2) = 2      -- BEFORE
       and (t.tgtype & 1) = 1      -- ROW
       and (t.tgtype & 16) = 16    -- UPDATE (of family_id)
       and (select array_agg(a.attname::text)
              from unnest(t.tgattr) k join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k)
           = array['family_id']) then
    raise exception '0503: trip_items does not carry the enabled BEFORE UPDATE OF family_id move guard';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.trip_items'::regclass
       and t.tgname = 'trg_trip_items_trip_id_family'
       and t.tgfoid = 'public.reference_shares_family()'::regprocedure
       and t.tgenabled <> 'D'
       and (t.tgtype & 2) = 2      -- BEFORE
       and (t.tgtype & 1) = 1      -- ROW
       and (t.tgtype & 4) = 4      -- INSERT
       and (t.tgtype & 16) = 16    -- UPDATE (of trip_id, family_id)
       and encode(t.tgargs, 'escape') = E'trip_id\\000trips\\000'
       and (select array_agg(a.attname::text order by a.attname::text)
              from unnest(t.tgattr) k join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k)
           = array['family_id', 'trip_id']) then
    raise exception '0503: trip_items does not carry the enabled BEFORE INSERT OR UPDATE OF trip_id, family_id binding to trips';
  end if;
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.trip_item_family_change_guard()'::regprocedure
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    raise exception '0503: the move guard is not SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
