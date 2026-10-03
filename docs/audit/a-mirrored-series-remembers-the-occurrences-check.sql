-- Behavioural proof for 0483: `sync_calendar_events.exception_dates` exists with
-- the shape the engines and the feed rely on, and a row written without it
-- reads back empty rather than null.
--
-- The engines spread `exception_dates` into every mirrored insert and update and
-- the feed selects it; both carry a fallback for a database that has not
-- applied 0483, keyed on the one error that names the column. This probe is the
-- other half: on a database that HAS applied it, the column is a non-null
-- timestamptz array defaulting to '{}', so the feed's `?? []` is never reached
-- for a real row and a one-off event never carries a null the ICS writer would
-- have to think about.
--
-- Wrapped in a transaction that is rolled back; it leaves nothing behind. Run
-- BEFORE 0483 it fails at the first check, which is the control.
begin;
do $$
declare
  fam   uuid;
  cal   uuid;
  plain uuid;
  series uuid;
  col   record;
  got   timestamptz[];
begin
  select data_type, udt_name, is_nullable, column_default
    into col
  from information_schema.columns
  where table_schema = 'public' and table_name = 'sync_calendar_events' and column_name = 'exception_dates';
  if col is null then
    raise exception 'sync_calendar_events.exception_dates does not exist — 0483 has not been applied (this is the pre-migration control)';
  end if;
  if col.udt_name is distinct from '_timestamptz' then
    raise exception 'exception_dates is % (%), not timestamptz[]', col.data_type, col.udt_name;
  end if;
  if col.is_nullable is distinct from 'NO' then raise exception 'exception_dates is nullable; the feed would have to think about null'; end if;
  if col.column_default is distinct from '''{}''::timestamp with time zone[]' then
    raise exception 'exception_dates defaults to %, not an empty array', col.column_default;
  end if;

  delete from public.families where name = 'Mirrored-series probe';
  insert into public.families (name) values ('Mirrored-series probe') returning id into fam;
  insert into public.sync_calendars (family_id, provider, external_id, name, timezone, is_owned_locally)
    values (fam, 'google', 'probe-cal', 'Probe', 'America/New_York', false) returning id into cal;

  -- A one-off written the way every row before 0483 was: no mention of the column.
  insert into public.sync_calendar_events (calendar_id, family_id, provider, external_id, title, starts_at)
    values (cal, fam, 'google', 'dentist', 'Dentist', '2026-07-15T13:00:00Z') returning id into plain;
  select exception_dates into got from public.sync_calendar_events where id = plain;
  if got is null then raise exception 'a row written without exception_dates reads back NULL, not an empty array'; end if;
  if cardinality(got) <> 0 then raise exception 'a one-off has % exception date(s)', cardinality(got); end if;

  -- A series that gave up two occurrences, as the engine writes it.
  insert into public.sync_calendar_events (calendar_id, family_id, provider, external_id, title, starts_at, recurrence_rule, exception_dates)
    values (cal, fam, 'google', 'piano', 'Piano', '2026-07-01T19:00:00Z', 'FREQ=WEEKLY;BYDAY=WE',
            array['2026-07-22T19:00:00Z', '2026-07-29T19:00:00Z']::timestamptz[])
    returning id into series;
  select exception_dates into got from public.sync_calendar_events where id = series;
  if cardinality(got) <> 2 or got[1] <> '2026-07-22T19:00:00Z'::timestamptz or got[2] <> '2026-07-29T19:00:00Z'::timestamptz then
    raise exception 'the series read back % instead of its two exception dates', got;
  end if;

  -- The engine's fold is a read-merge-write on this column; the merged array lands as written.
  update public.sync_calendar_events set exception_dates = array['2026-07-22T19:00:00Z', '2026-07-29T19:00:00Z', '2026-08-05T19:00:00Z']::timestamptz[] where id = series;
  select exception_dates into got from public.sync_calendar_events where id = series;
  if cardinality(got) <> 3 then raise exception 'after the fold the series has % exception date(s), not three', cardinality(got); end if;

  raise notice 'OK  sync_calendar_events.exception_dates is a non-null timestamptz[] defaulting to empty; a one-off reads back empty and a series reads back what it gave up';
end $$;
rollback;
