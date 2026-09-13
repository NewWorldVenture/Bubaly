-- Bubaly :: 0291 A family with sync data can be deleted again
-- ----------------------------------------------------------------------------
-- `sync_log_change()` is an AFTER-trigger on `sync_calendar_events`,
-- `sync_notes` and `sync_reminders`. On DELETE it writes a row to
-- `sync_change_logs` carrying the same `family_id`, so a client that is offline
-- can learn the row went away.
--
-- That is right for an ordinary delete and wrong for a cascade. Deleting a
-- family cascades into those three tables, the trigger then inserts a log row
-- naming a family Postgres has ALREADY removed, and
-- `sync_change_logs_family_id_fkey` rejects it — aborting the whole
-- transaction. The family survives, and the delete can never succeed:
--
--   ERROR: insert or update on table "sync_change_logs" violates foreign key
--          constraint "sync_change_logs_family_id_fkey"
--   DETAIL: Key (family_id)=(…) is not present in table "families".
--   CONTEXT: PL/pgSQL function sync_log_change() line 11
--
-- Reproduced directly: create a family, insert one `sync_notes` row, delete the
-- family — it fails. Without the sync row the same delete succeeds, which is
-- why this has gone unnoticed: the admin console only deletes families it just
-- created (a failed provision rolling itself back), and user-facing account
-- closure is SOFT (`families.closed_at`), so nothing in normal use deletes an
-- established household. A hard delete — a GDPR erasure, or the teardown in
-- tests/e2e/authenticated.spec.ts — cannot complete.
--
-- The fix is to stop logging a change for a family that no longer exists. Such
-- a row describes a sync no client can ever consume: the family is gone, and
-- every log row for it is being cascaded away in the same statement. An
-- ordinary delete of one note by a live family is unaffected — the family row
-- is still there, the `exists` check passes, and the log is written as before.
--
-- Idempotent (CREATE OR REPLACE); no data change.

create or replace function public.sync_log_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_family uuid;
  v_item public.sync_item_type;
  v_origin text;
begin
  v_item := tg_argv[0]::public.sync_item_type;
  if tg_op = 'DELETE' then
    v_family := old.family_id;
    -- Cascade from `families`: the parent is already gone, so this log row
    -- cannot satisfy its foreign key and would abort the delete. There is also
    -- nothing to tell a client — the whole family's sync history is going with
    -- it in this same statement.
    if not exists (select 1 from public.families where id = v_family) then
      return old;
    end if;
    v_origin := coalesce(old.metadata->>'origin', 'local');
    insert into public.sync_change_logs (family_id, item_type, local_id, operation, origin, before)
    values (v_family, v_item, old.id, 'delete', v_origin, to_jsonb(old));
    return old;
  else
    v_family := new.family_id;
    v_origin := coalesce(new.metadata->>'origin', 'local');
    insert into public.sync_change_logs (family_id, item_type, local_id, operation, origin, before, after)
    values (v_family, v_item,
            new.id,
            case when tg_op = 'INSERT' then 'create' else 'update' end,
            v_origin,
            case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
            to_jsonb(new));
    return new;
  end if;
end; $$;
