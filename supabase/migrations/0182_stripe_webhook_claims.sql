-- FamilyOS :: 0182 - Serialize Stripe webhook event claims
--
-- A unique event id prevents duplicate rows but does not prevent two concurrent
-- deliveries from both processing a row still marked as processing. Track the
-- claim start time so only one active worker processes an event at a time while
-- abandoned claims remain recoverable.

alter table public.stripe_webhook_events
  add column if not exists processing_started_at timestamptz,
  add column if not exists claim_token text;

create index if not exists idx_stripe_webhook_events_processing
  on public.stripe_webhook_events (status, processing_started_at);
