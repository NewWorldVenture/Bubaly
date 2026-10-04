\set ON_ERROR_STOP on
-- Run only in an empty, disposable synthetic database. An existing bills table
-- causes CREATE to fail before the source migration is executed.
begin;
create table public.bills (id integer primary key, due_date date not null);
insert into public.bills values (1, '2026-02-28'), (2, '2026-03-28');
\ir ../../supabase/migrations/0491_preserve_recurring_bill_anchor.sql
\ir ../../supabase/migrations/0491_preserve_recurring_bill_anchor.sql
do $$
begin
  if exists (select 1 from public.bills where due_day is not null)
     or (select due_date from public.bills where id = 1) <> date '2026-02-28'
     or (select due_date from public.bills where id = 2) <> date '2026-03-28' then
    raise exception 'Migration guessed or changed a legacy anchor';
  end if;
  if exists (
    select 1 from pg_catalog.pg_attrdef d
    join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = 'public.bills'::regclass and a.attname = 'due_day'
  ) then
    raise exception 'Unknown anchors must not receive a default';
  end if;
  insert into public.bills values (3, '2026-02-28', 31), (4, '2026-01-01', 1), (5, '2026-01-01', null);
  begin
    insert into public.bills values (6, '2026-01-01', 0);
    raise exception 'Day zero was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.bills values (7, '2026-01-01', 32);
    raise exception 'Day 32 was accepted';
  exception when check_violation then null;
  end;
  if (select count(*) from public.bills) <> 5 then
    raise exception 'Constraint failures changed persisted rows';
  end if;
end $$;
select 'bill anchor migration: replay, null legacy dates, no default, bounds PASS' as result;
rollback;
