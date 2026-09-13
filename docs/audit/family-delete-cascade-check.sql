-- family-delete-cascade-check.sql
--
-- A family can actually be deleted, and deleting one note still tells the
-- sync clients about it.
--
-- 0287 exists because those two pull in opposite directions. `sync_log_change()`
-- fires AFTER DELETE on sync_calendar_events / sync_notes / sync_reminders and
-- writes a `sync_change_logs` row carrying the family_id — correct for one note
-- going away, fatal for a cascade, where Postgres has already removed the
-- parent and the log row's foreign key cannot be satisfied. The delete aborted
-- and the family survived.
--
-- Normal use never hit it: account closure is SOFT (families.closed_at), and
-- the admin console only deletes families it just created. A hard erasure, or
-- the teardown in tests/e2e/authenticated.spec.ts, did.
--
-- Run by docs/audit/run-probes.sh, which globs docs/audit/*-check.sql.

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_family uuid := '00000000-0000-4000-8000-00000000ca5c';
  v_deletes integer;
begin
  insert into public.families (id, name, created_by) values (v_family, 'Cascade Probe', null);
  insert into public.sync_notes (family_id, title) values (v_family, 'Probe note');

  -- (1) An ordinary delete by a LIVE family must still be logged. 0287 must not
  --     have bought the cascade by silencing the feature.
  delete from public.sync_notes where family_id = v_family;
  select count(*) into v_deletes
  from public.sync_change_logs where family_id = v_family and operation = 'delete';
  if v_deletes <> 1 then
    raise exception 'A-12 FAIL: an ordinary sync delete was not logged (% rows, expected 1)', v_deletes;
  end if;
  raise notice 'A-12 OK: an ordinary sync delete is still logged';

  -- (2) Deleting the family, with a sync row present, must succeed. Before 0287
  --     this raised sync_change_logs_family_id_fkey and rolled the whole
  --     transaction back.
  insert into public.sync_notes (family_id, title) values (v_family, 'Second probe note');
  delete from public.families where id = v_family;

  if exists (select 1 from public.families where id = v_family) then
    raise exception 'A-12 FAIL: the family survived its own delete';
  end if;
  raise notice 'A-12 OK: a family holding sync data can be deleted';
end $$;

rollback;
