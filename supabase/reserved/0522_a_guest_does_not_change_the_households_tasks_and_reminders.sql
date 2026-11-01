-- 0522 — A guest does not change the household's tasks and reminders.
-- 0464's guard, on four more tables it did not reach. Requested on #771 in
-- comment 6402500834, before any SQL: the database half of KIDS-O01 ("Needs
-- trg_todo_items_not_a_guests and trg_todo_lists_not_a_guests using
-- public.household_write_is_not_a_guests()") and of Support's 6370895638 (a)
-- ("DB half needs a schema change: a guest-write guard on family_reminders").
--
-- 0464 (ROLE-M03) made the rule every model of the product states true in the
-- database for the eight resources /family/permissions names: a guest views
-- the household; it does not rewrite it ("Guest: View the shared calendar,
-- lists and plans", lib/constants/roles.ts; the trust engine's ['view']). 0498
-- added calendar_feeds and grocery_lists. The household's tasks and reminders
-- still read and write with any active membership, and measured on a replay of
-- main with every held file through 0521 applied, as an active guest:
--
--   todo_lists        insert OK 1   rename OK 1               delete OK 1
--   todo_items        insert OK 1   tick another's task OK 1  delete OK 0 (0479)
--   reminder_lists    insert OK 1   rename OK 1               delete OK 1
--   family_reminders  insert OK 1   complete another's OK 1   delete OK 0 (0479)
--
-- This wires 0464's own function onto the four tables, as 0498 did: a BEFORE
-- INSERT, UPDATE and DELETE trigger, trg_<table>_not_a_guests, that refuses a
-- caller whose role in the row's family is `guest` with 42501 ("A guest can
-- see the household but not change it"). No new function; nothing in 0464's
-- eight or 0498's two changes. Parents, adults, teens, children and caregivers
-- write all four exactly as before, under the policies already there (0479's
-- delete rules included). The service role and session-less writers stay
-- exempt, as everywhere in this series. ensure_default_todo_list (0443) is
-- SECURITY INVOKER, so a guest's first capture is refused at the insert, as a
-- guest's grocery capture already is under 0498.
--
-- The application: app/(app)/dashboard/todos/actions.ts already refuses a
-- guest before any write; a guest's reminder write answers 42501, which
-- describeDbError shows as "You don't have permission", until Support's
-- reminder app half (claude/family-lists-polls-7q6vtf) lands.
--
-- HELD: 0522, requested on #771 in comment 6402500834 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-guest-does-not-change-the-households-tasks-and-reminders-check.sql
-- and .github/workflows/guest-tasks-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  t text;
begin
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception '0522 needs household_write_is_not_a_guests() from 0464';
  end if;
  foreach t in array array['todo_lists', 'todo_items', 'reminder_lists', 'family_reminders'] loop
    if to_regclass('public.' || t) is null then
      raise exception '0522: public.% does not exist', t;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = t and column_name = 'family_id') then
      raise exception '0522: public.%.family_id does not exist', t;
    end if;
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_not_a_guests', t);
    execute format('create trigger %I before insert or update or delete on public.%I '
                   'for each row execute function public.household_write_is_not_a_guests()',
                   'trg_' || t || '_not_a_guests', t);
  end loop;
end
$$;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger
   where tgfoid = 'public.household_write_is_not_a_guests()'::regprocedure
     and tgenabled <> 'D'
     and tgrelid in ('public.todo_lists'::regclass, 'public.todo_items'::regclass,
                     'public.reminder_lists'::regclass, 'public.family_reminders'::regclass)
     and (tgtype & 1) = 1                     -- FOR EACH ROW
     and (tgtype & 2) = 2                     -- BEFORE
     and (tgtype & 28) = 28;                  -- INSERT (4), DELETE (8), UPDATE (16)
  if n <> 4 then
    raise exception '0522: % of 4 tables carry the guest guard on insert, update and delete', n;
  end if;
end
$$;
