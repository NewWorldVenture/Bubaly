-- 0337_an_email_event_is_counted_once.sql
--
-- EMAIL-002, the half left open: one Resend event could move a campaign
-- counter twice.
--
-- The webhook claims an event by svix_id, increments the campaign's
-- opens/clicks/bounces/unsubscribes, and only then finalises the receipt. When
-- finalisation fails the claim is released to 'error', Resend retries, the
-- retry re-claims the row, and the counter moves a second time for one event.
-- The ledger recorded why it was left: reordering only trades the double count
-- for an under-count, and a correct fix needs the counter to be applied ONCE
-- PER EVENT — a transaction, or a marker beside the receipt — which was SQL.
--
-- This is both. `counter_applied_at` marks the receipt, and
-- apply_resend_campaign_counter() sets the marker and increments the counter in
-- ONE statement-level transaction, so they cannot come apart: a retry of an
-- event whose counter was applied finds the marker and counts nothing. The
-- increment is `coalesce(col, 0) + 1` in SQL, which row-locks the campaign, so
-- it also retires the read-then-compare-and-set loop the route used to close
-- the concurrent lost update — that loop remains in the route only as the
-- fallback for a database without this migration.
--
-- The marker is set only by the worker that holds the claim (status
-- 'processing' at its own received_at), so a stale worker cannot count an
-- event another has claimed. Service role only: the webhook route is its sole
-- caller, and no session has any business moving a campaign's numbers.
--
-- Idempotent.

do $$
begin
  if to_regclass('public.resend_webhook_events') is null
     or to_regclass('public.marketing_email_campaigns') is null then
    return;
  end if;

  alter table public.resend_webhook_events
    add column if not exists counter_applied_at timestamptz;

  comment on column public.resend_webhook_events.counter_applied_at is
    'When this event''s campaign counter was applied. Set with the increment in one transaction by apply_resend_campaign_counter(), so a retried event is never counted twice. EMAIL-002.';

  create or replace function public.apply_resend_campaign_counter(
    p_svix_id     text,
    p_received_at timestamptz,
    p_campaign_id text,
    p_field       text
  ) returns text
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $fn$
  declare
    marked int;
    already timestamptz;
    bumped int;
  begin
    if p_field not in ('opens', 'clicks', 'bounces', 'unsubscribes') then
      raise exception 'not a campaign counter: %', p_field using errcode = '22023';
    end if;

    update public.resend_webhook_events
       set counter_applied_at = now()
     where svix_id = p_svix_id
       and status = 'processing'
       and received_at = p_received_at
       and counter_applied_at is null;
    get diagnostics marked = row_count;

    if marked = 0 then
      select counter_applied_at into already
        from public.resend_webhook_events where svix_id = p_svix_id;
      -- Counted by an earlier attempt of this same event: nothing to do.
      if already is not null then return 'already_applied'; end if;
      -- Otherwise this worker no longer holds the claim.
      return 'claim_lost';
    end if;

    execute format(
      'update public.marketing_email_campaigns set %1$I = coalesce(%1$I, 0) + 1 where id::text = $1',
      p_field
    ) using p_campaign_id;
    get diagnostics bumped = row_count;

    -- An unknown campaign is left alone, as before; the event is still marked
    -- so a retry does not look again.
    return case when bumped = 0 then 'no_campaign' else 'applied' end;
  end;
  $fn$;

  comment on function public.apply_resend_campaign_counter(text, timestamptz, text, text) is
    'Apply one Resend event''s campaign counter exactly once: marks resend_webhook_events.counter_applied_at and increments the counter in one transaction, only for the worker holding the claim. EMAIL-002.';

  revoke all on function public.apply_resend_campaign_counter(text, timestamptz, text, text) from public, anon, authenticated;
  grant execute on function public.apply_resend_campaign_counter(text, timestamptz, text, text) to service_role;
end
$$;
