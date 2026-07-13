-- FamilyOS :: 0189 - Reconcile Stripe webhook claim columns
--
-- Some environments recorded the original 0182 migration while the ALTER TABLE
-- did not complete. Reapply the additive shape so the webhook code and live
-- schema agree without touching existing event rows.

begin;

alter table public.stripe_webhook_events
  add column if not exists processing_started_at timestamptz,
  add column if not exists claim_token text;

create index if not exists idx_stripe_webhook_events_processing
  on public.stripe_webhook_events (status, processing_started_at);

commit;
