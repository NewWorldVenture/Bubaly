-- FamilyOS :: 0181 - Durable Guardian callback replay protection
--
-- Twilio signatures authenticate the sender, but a signed callback can still be
-- retried or replayed. Callback claims are service-role only and are created
-- before Guardian pipelines, AI, notifications, or telephony side effects run.

create table if not exists public.guardian_callback_events (
  event_id      text primary key,
  callback_type text not null,
  status        text not null default 'processing'
                check (status in ('processing', 'processed', 'error')),
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);

create index if not exists idx_guardian_callback_events_received
  on public.guardian_callback_events (received_at desc);

alter table public.guardian_callback_events enable row level security;
-- No policies: callback state is service-role only.
