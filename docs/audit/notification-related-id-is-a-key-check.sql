-- A notification's related_id holds a dedupe KEY, not a uuid. (MAIN-F-010, migration 0293)
--
-- Three subsystems put a composite key in `notifications.related_id` on
-- purpose: 'moment:<eventId>:<date>', 'conflict:<eventIds>', and the approval
-- reminders' dedupe key. While the column was uuid, Postgres rejected every
-- one (22P02), the failure was caught per family, and that family got NO
-- notifications from the run while the cron reported success. 0293 widened
-- the column to text and checks itself once, at migration time; nothing checked
-- it afterwards, so a later migration retyping the column would bring the
-- silent outage back.
--
--   the column is text                                   -> asserted
--   a composite key is stored and read back by `in (...)` -> asserted
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $$
declare
  col_type text;
  key text := 'moment:3fd2b8f5-0000-4000-8000-000000000001:2026-09-14';
  found int;
begin
  select data_type into col_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'notifications' and column_name = 'related_id';
  if col_type is null then
    raise exception 'MAIN-F-010 FAIL: public.notifications.related_id does not exist, so this proves nothing';
  end if;
  if col_type <> 'text' then
    raise exception 'MAIN-F-010 FAIL: notifications.related_id is %, not text; every composite dedupe key is rejected and the family gets no notifications', col_type;
  end if;

  begin
    insert into public.notifications (family_id, type, title, related_type, related_id)
    values ('00000000-0000-4000-8000-0000000000f1', 'calendar_event', 'related-id probe', 'calendar_events', key);
  exception when invalid_text_representation then
    raise exception 'MAIN-F-010 FAIL: a composite dedupe key was rejected (22P02)';
  end;

  select count(*) into found
  from public.notifications
  where family_id = '00000000-0000-4000-8000-0000000000f1' and related_id in (key, 'conflict:a,b');
  if found <> 1 then
    raise exception 'MAIN-F-010 FAIL: the dedupe read found % rows for the key just written, expected 1', found;
  end if;
end $$;

rollback;
