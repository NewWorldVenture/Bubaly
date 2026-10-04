-- 0488: a month-end bill keeps its day. (audit note of 2026-10-04 07:45 UTC on #932)
--
-- Number reserved by the coordinator on #699 (5979394236); filename announced
-- on #771 before this edit. Repository candidate only: not applied anywhere by
-- this change.
--
-- `bills.due_date` was the only date a bill had. "Mark paid" rolls a recurring
-- bill to its next occurrence by stepping from that date, so a bill due on the
-- 31st, persisted as Feb 28 after its first roll, stepped to Mar 28 from there
-- and the month-end cadence was lost for good. At Feb 28 the row cannot tell a
-- bill due on the 28th from one clamped from the 29th, 30th or 31st, so no
-- reading of due_date settles it. This column remembers the day the series is
-- anchored on.
--
-- Null reads the day from due_date, exactly as before, so every existing row
-- behaves as it did; the first roll of a month-based bill writes it, and the
-- add forms write it for a new recurring bill. No default, no backfill, no
-- index, no policy or function change; RLS is untouched.
alter table public.bills add column if not exists due_day smallint
  check (due_day between 1 and 31);

comment on column public.bills.due_day is
  'Day of month a month-based recurring bill is anchored on (1-31); null reads the day from due_date. Lets a bill due on the 31st come back to the 31st after a short month.';
