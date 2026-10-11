-- 0498 — A guest cannot feed the calendar or rewrite a grocery list.
-- 0464's guard, on two tables it did not reach. Found and reproduced
-- 2026-10-10 on a replay of every runnable migration.
--
-- 0464 (ROLE-M03) made the rule every model of the product states, "a guest
-- views the household; it does not rewrite it", true in the database for the
-- eight resources /family/permissions names, with a BEFORE INSERT, UPDATE and
-- DELETE trigger that refuses a guest with 42501. Two tables sit just outside
-- that list, and through them a guest still changes what the household sees:
--
--   * calendar_feeds. Its only policy is `ALL` for is_family_member, so a guest
--     subscribes the family to any ICS URL (measured: 1 row, while the same
--     guest's direct calendar_events insert is refused by 0464). What the feed
--     row then leads to depends on the importer, which this does not touch.
--     The in-app sync runs on the guest's own session and is refused at
--     calendar_events. The nightly sync (app/api/cron/calendar-feeds) runs
--     with the service client, which 0464 exempts, so it can import that
--     feed's events into the family calendar, but only once the held 0490's
--     calendar_feed_apply_sync exists (without it, as on this candidate, the
--     importer refuses every event write), and only if the fetch and parse
--     succeed and the importer's own requirements are met. The SQL proof here
--     covers the feed and list rows, not that import chain.
--   * grocery_lists, the parent of the guarded grocery_items. A guest creates,
--     renames and deletes lists (measured: 1 row each). Deleting a list that
--     has items already fails, because the cascade fires the items guard.
--
-- This wires 0464's own function onto both tables. No new function, nothing
-- in 0464's eight changes, and the service role and session-less writers stay
-- exempt as they are everywhere in that series. Parents, adults, teens,
-- children and caregivers write both tables exactly as before. Only the table
-- is guarded: the calendar lane's importer and feed actions are not touched.
--
-- RESIDUAL, recorded: feeds a guest already added are not removed. They stay
-- eligible for a later service-role sync. Cleaning them up, and any importer
-- follow-on, belongs to the calendar importer's owner; no data is changed here.
--
-- HELD: 0498, the first number above 0497, requested on #771 in comment
-- 6094699645 and confirmed as a held source and probe reservation in #981
-- comment 6094770726 (not an installation or production approval). It stays
-- in supabase/reserved/ until every number below it has landed. Proven by
-- docs/audit/reserved/a-guest-cannot-feed-the-calendar-or-rewrite-a-grocery-list-check.sql
-- and .github/workflows/guest-household-runtime.yml. Not applied to production
-- by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  t text;
begin
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception '0498 needs household_write_is_not_a_guests() from 0464';
  end if;
  foreach t in array array['calendar_feeds', 'grocery_lists'] loop
    if to_regclass('public.' || t) is null then
      raise exception '0498: public.% does not exist', t;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = t and column_name = 'family_id') then
      raise exception '0498: public.%.family_id does not exist', t;
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
     and tgrelid in ('public.calendar_feeds'::regclass, 'public.grocery_lists'::regclass)
     and (tgtype & 2) = 2                     -- BEFORE
     and (tgtype & 28) = 28;                  -- INSERT (4), DELETE (8), UPDATE (16)
  if n <> 2 then
    raise exception '0498: % of 2 tables carry the guest guard on insert, update and delete', n;
  end if;
end
$$;
