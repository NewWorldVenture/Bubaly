-- Preserve the owner-selected monthly day even when February clamps a due date.
-- Generated with Supabase CLI, then assigned 0491 above observed reservations
-- through 0490. This is an unapplied source reservation, not remote history.
-- Never backfill from due_date: a legacy February 28 may mean day 28, 29, 30 or 31.
alter table public.bills add column if not exists due_day smallint;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.bills'::regclass
      and conname = 'bills_due_day_anchor_range'
  ) then
    alter table public.bills add constraint bills_due_day_anchor_range
      check (due_day is null or due_day between 1 and 31);
  end if;
end $$;

comment on column public.bills.due_day is
  'Owner-selected day of month, preserved across clamped months. NULL means the historical anchor is not recorded; require confirmation when ambiguous.';
