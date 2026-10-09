-- ── 0488: a month-end bill keeps its day ─────────────────────────────────────
--
-- `bills.due_day` is the day of month a month-based recurring bill is anchored
-- on, so a bill due on the 31st that "Mark paid" rolls to Feb 28 comes back on
-- Mar 31 (lib/finance/recurring.ts `billPaidPatch`). This proves, on the replayed
-- schema, what the app relies on:
--
--   * the column is a nullable smallint with no default, so every row written
--     before 0488 (and every insert that leaves it out) reads null, and null
--     means the original anchor is unknown;
--   * exactly ONE check constraint names it, so re-applying 0488 onto a schema
--     that already has it (docs/audit/rehearse-ledger-repair.sh) adds nothing;
--   * the roll Mark paid writes lands, and a day outside 1..31 is refused.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/reserved/a-month-end-bill-keeps-its-day-check.sql
--
-- Everything it writes is rolled back. It writes under the anchor family that
-- pg-bootstrap.sh creates, and under no fixed id of its own.
begin;

do $$
declare
  fam constant uuid := '00000000-0000-4000-8000-0000000000f1';
  col record;
  checks int;
  bill uuid;
  day_now smallint;
begin
  select data_type, is_nullable, column_default into col
    from information_schema.columns
   where table_schema = 'public' and table_name = 'bills' and column_name = 'due_day';
  if not found then
    raise exception '0488: bills.due_day is missing';
  end if;
  if col.data_type <> 'smallint' or col.is_nullable <> 'YES' or col.column_default is not null then
    raise exception '0488: bills.due_day is % (nullable %, default %); want a nullable smallint with no default',
      col.data_type, col.is_nullable, coalesce(col.column_default, 'none');
  end if;

  select count(*) into checks
    from pg_constraint
   where conrelid = 'public.bills'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%due_day%';
  if checks <> 1 then
    raise exception '0488: % check constraints name bills.due_day; want exactly one (a replay must not add another)', checks;
  end if;

  -- A bill written the way every pre-0488 writer writes it.
  insert into public.bills (family_id, name, amount, due_date, is_recurring, recurrence)
  values (fam, '0488 probe: rent', 1000, '2026-01-31', true, 'monthly')
  returning id into bill;
  select due_day into day_now from public.bills where id = bill;
  if day_now is not null then
    raise exception '0488: a bill inserted without due_day reads %, not null', day_now;
  end if;

  -- The roll Mark paid writes: Feb 28, with the 31st kept.
  update public.bills set due_date = '2026-02-28', due_day = 31, status = 'upcoming' where id = bill;
  select due_day into day_now from public.bills where id = bill;
  if day_now is distinct from 31 then
    raise exception '0488: the roll to Feb 28 kept day %, not 31', day_now;
  end if;

  begin
    update public.bills set due_day = 0 where id = bill;
    raise exception '0488: due_day 0 was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.bills set due_day = 32 where id = bill;
    raise exception '0488: due_day 32 was accepted';
  exception when check_violation then null;
  end;

  raise notice '0488 OK: bills.due_day is a nullable smallint under one 1..31 check; a pre-0488 insert reads null; Feb 28 keeps the 31st';
end $$;

rollback;
