-- Per-recipient push delivery receipts. (PUSH-003)
--
-- `notifications.pushed_at` is one timestamp for the whole notification. A
-- whole-family notice fans out to every active member, and if ANY recipient's
-- delivery failed (a device read error, a provider outage) the row stayed
-- pending, so the next run re-sent it to EVERY recipient — including the ones
-- whose phones had already buzzed. The same happened when a run died between
-- sends. A medication reminder delivered three times to the parent whose
-- phone worked, because the teenager's did not.
--
-- A receipt per (notification, recipient) makes the retry precise: the
-- dispatcher skips recipients who already have one, writes one right after a
-- recipient's delivery succeeds, and stamps `pushed_at` only when every
-- permitted recipient is receipted. The residual — a process dying between a
-- successful send and its receipt write — repeats one delivery to one person,
-- which is the at-least-once floor without provider idempotency, and is
-- preferred to the alternative of claiming first and LOSING the notification.
--
-- Service-only: the dispatcher runs with the service role (the two cron routes
-- and the on-demand generate route). No client reads or writes receipts.

create table if not exists public.notification_push_receipts (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id uuid not null,
  delivered_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

alter table public.notification_push_receipts enable row level security;
revoke all on table public.notification_push_receipts from public, anon, authenticated;
grant select, insert, delete on table public.notification_push_receipts to service_role;

comment on table public.notification_push_receipts is
  'PUSH-003: one row per recipient a push notification was delivered to; the dispatcher skips receipted recipients on retry. Service-only.';

do $check$
begin
  if has_table_privilege('anon', 'public.notification_push_receipts', 'select')
     or has_table_privilege('authenticated', 'public.notification_push_receipts', 'select')
     or has_table_privilege('authenticated', 'public.notification_push_receipts', 'insert') then
    raise exception '0339: a client role can reach notification_push_receipts';
  end if;
  if not has_table_privilege('service_role', 'public.notification_push_receipts', 'insert') then
    raise exception '0339: service_role cannot write receipts, so the dispatcher is broken';
  end if;
end
$check$;
