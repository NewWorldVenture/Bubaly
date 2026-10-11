-- Bubaly :: 0485 - a device is found by its key
-- ----------------------------------------------------------------------------
-- From the 2026-10-10 notifications/push audit (audit/notifications-push-fix),
-- numbered 0485 by owner decision of 2026-10-10. The receipt's one item written
-- as SQL: `create index on public.push_devices (device_key)`.
--
-- push_devices (0035) is unique on (user_id, device_key), which serves the
-- subscribe upsert (one row per user per device) and a lookup by user. The
-- sign-in takeover the audit added looks a device up by its KEY ALONE, across
-- users, so a shared or handed-down phone stops receiving the previous
-- account's private notifications and the token moves to whoever signed in.
-- That read runs on every launch; without a device_key-leading index it is a
-- sequential scan of every registered device.
--
-- The receipt's two other items are NOT written here, because the receipt
-- gives neither as SQL nor as an unambiguous description: the partial unique
-- index on notifications names no predicate and would fail on the duplicate
-- rows the finding itself reports, and notification_reads has no columns,
-- policies or callers yet. They stay with the owner.
--
-- Idempotent: IF NOT EXISTS.

create index if not exists idx_push_devices_device_key
  on public.push_devices (device_key);

comment on index public.idx_push_devices_device_key is
  'A device is found by its key alone on every launch, across users, so a sign-in on a shared phone can take the registration over (0485).';

-- ── self-check ───────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
     where c.relname = 'idx_push_devices_device_key'
       and i.indrelid = 'public.push_devices'::regclass
       and i.indisvalid
       and a.attname = 'device_key'
  ) then
    raise exception '0485: idx_push_devices_device_key is missing, invalid or does not lead with device_key';
  end if;
  raise notice '0485 OK: push_devices is indexed by device_key';
end
$$;
