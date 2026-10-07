-- 0488: a month-end bill keeps its day. (audit note of 2026-10-04 07:45 UTC on #932)
--
-- RESERVED as 0488 (the bill-anchor reservation in the preserved allocation
-- map, owner decision of 2026-10-04 on #771) and HELD in supabase/reserved/:
-- 0475-0487 must land first, so neither the replay nor `supabase db push`
-- reads this file yet. It moves into supabase/migrations/ as 0488 when the
-- sequence reaches it. The app works without it (lib/finance/recurring.ts
-- writeBillPatch). Repository candidate only: not applied anywhere.
--
-- `bills.due_date` was the only date a bill had. "Mark paid" rolls a recurring
-- bill to its next occurrence by stepping from that date, so a bill due on the
-- 31st, persisted as Feb 28 after its first roll, stepped to Mar 28 from there
-- and the month-end cadence was lost for good. At Feb 28 the row cannot tell a
-- bill due on the 28th from one clamped from the 29th, 30th or 31st, so no
-- reading of due_date settles it. This column remembers the day the series is
-- anchored on.
--
-- Null means the original day is unknown; it is not a license to guess a
-- clamped legacy anchor. No default or backfill is added. The application
-- requests an explicit day where the legacy date is ambiguous and refuses a
-- write that would lose that day on an older schema. Proven legacy days can
-- advance only when the date itself retains their anchor.
--
-- Re-runnable: the column is added only if absent, and the check is named and
-- added only if absent, so replaying this file onto a schema that already has
-- it (docs/audit/rehearse-ledger-repair.sh) changes nothing.
alter table public.bills add column if not exists due_day smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bills'::regclass
       and conname = 'bills_due_day_check'
  ) then
    alter table public.bills
      add constraint bills_due_day_check check (due_day between 1 and 31);
  end if;
end $$;

comment on column public.bills.due_day is
  'Day of month a month-based recurring bill is anchored on (1-31); null means the original anchor is unknown. Lets a bill due on the 31st come back to the 31st after a short month.';
