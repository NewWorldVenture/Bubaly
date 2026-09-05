-- Bubaly :: 0180 - Durable Resend webhook replay protection
--
-- Svix signatures authenticate Resend deliveries, but a valid signed event can
-- still be replayed. Store each Svix id so campaign counters and engagement
-- automations are processed once while failed rows remain retryable.

create table if not exists public.resend_webhook_events (
  svix_id      text primary key,
  event_type   text not null,
  status       text not null default 'processing'
               check (status in ('processing', 'processed', 'error')),
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text
);

create index if not exists idx_resend_webhook_events_status
  on public.resend_webhook_events (status, received_at desc);

alter table public.resend_webhook_events enable row level security;
-- No policies: webhook state is service-role only.
