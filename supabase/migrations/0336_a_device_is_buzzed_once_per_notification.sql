-- 0336_a_device_is_buzzed_once_per_notification.sql
--
-- PUSH-003 (the half left open) / PUSH-006: a per-device delivery receipt.
--
-- `notifications.pushed_at` is one timestamp for the whole notification. A
-- whole-family notice fans out to every member's every device, and the row is
-- stamped only when EVERY send succeeds — so when one of five devices fails,
-- the row stays pending, and the next run sends to all five again. Four phones
-- buzz twice for the one that did not. The ledger recorded why this was left:
-- claiming the row before sending would trade the duplicate for a LOST
-- notification whenever a worker died mid-send, and a missed medication
-- reminder is worse than a repeated one.
--
-- A receipt per (notification, device) closes it without that trade. The
-- dispatcher records each device it actually reached; a retry skips exactly
-- those and sends to the rest. Nothing is claimed ahead of a send, so nothing
-- can be lost: at worst a receipt write fails after a real send and that ONE
-- device is reached once more.
--
-- Service-only, like app_settings' dispatch cursor: the dispatcher runs as the
-- service role from the cron routes and /api/notifications/generate, and no
-- client has any business reading which of a family's devices were reached.
-- Rows go with the notification or the device (on delete cascade), so a
-- pruned endpoint or an expired notification leaves no receipts behind.
--
-- Idempotent.

create table if not exists public.push_deliveries (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  device_id       uuid not null references public.push_devices(id) on delete cascade,
  delivered_at    timestamptz not null default now(),
  primary key (notification_id, device_id)
);

comment on table public.push_deliveries is
  'One row per device a notification''s push actually reached. The dispatcher skips these on retry, so a partial failure re-sends only to the devices that missed it. Service role only. PUSH-003/PUSH-006.';

-- The retry lookup is by notification (the primary key's leading column); the
-- cascade from a pruned device needs its own index.
create index if not exists push_deliveries_device_idx on public.push_deliveries (device_id);

alter table public.push_deliveries enable row level security;
-- No policies: RLS with none refuses every non-service session.
revoke all on table public.push_deliveries from anon, authenticated;
