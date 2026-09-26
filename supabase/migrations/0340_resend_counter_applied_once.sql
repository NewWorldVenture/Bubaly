-- A campaign counter moves once per webhook event. (EMAIL-002)
--
-- The Resend webhook claims an event by svix_id, applies its effects, then
-- finalises the receipt. The campaign counter (opens, clicks, bounces,
-- unsubscribes) moved BEFORE finalisation, so when finalisation failed the
-- claim was released to `error`, the provider retried, the retry re-claimed
-- the event and the counter moved a second time for a single open or click.
-- Reordering only traded that for an under-count on a failed counter write.
--
-- The counter application is now one statement's worth of work in one
-- transaction: mark this event's counter as applied (only if it has not been)
-- and increment the campaign, together or not at all. A retry of an event
-- whose counter already moved finds the marker and does nothing. The increment
-- is `coalesce(x, 0) + 1` in SQL, which is atomic under the row lock, so the
-- read-then-conditional-write loop in the route (the lost-update fix) is no
-- longer needed either.
--
-- Service-only: the webhook runs with the service role.

alter table public.resend_webhook_events add column if not exists counter_applied_at timestamptz;

create or replace function public.resend_apply_campaign_counter(p_svix_id text, p_campaign_id text, p_field text)
returns text
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_campaign uuid;
  v_rows int;
begin
  if p_field not in ('opens', 'clicks', 'bounces', 'unsubscribes') then
    raise exception 'resend_apply_campaign_counter: unknown counter %', p_field using errcode = 'invalid_parameter_value';
  end if;

  -- A campaign tag that is not a campaign id never becomes one on retry, so it
  -- is an unknown campaign rather than a failure to be retried for ever.
  begin
    v_campaign := p_campaign_id::uuid;
  exception when invalid_text_representation then
    return 'no_campaign';
  end;

  update public.resend_webhook_events
     set counter_applied_at = now()
   where svix_id = p_svix_id and counter_applied_at is null;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    if not exists (select 1 from public.resend_webhook_events where svix_id = p_svix_id) then
      raise exception 'resend_apply_campaign_counter: no claimed event %', p_svix_id using errcode = 'no_data_found';
    end if;
    return 'already_applied';
  end if;

  execute format('update public.marketing_email_campaigns set %1$I = coalesce(%1$I, 0) + 1 where id = $1', p_field)
    using v_campaign;
  get diagnostics v_rows = row_count;
  return case when v_rows = 0 then 'no_campaign' else 'applied' end;
end;
$$;

revoke all on function public.resend_apply_campaign_counter(text, text, text) from public, anon, authenticated;
grant execute on function public.resend_apply_campaign_counter(text, text, text) to service_role;

do $check$
begin
  if has_function_privilege('anon', 'public.resend_apply_campaign_counter(text, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.resend_apply_campaign_counter(text, text, text)', 'execute') then
    raise exception '0340: a client role can execute resend_apply_campaign_counter';
  end if;
  if not has_function_privilege('service_role', 'public.resend_apply_campaign_counter(text, text, text)', 'execute') then
    raise exception '0340: service_role cannot execute resend_apply_campaign_counter';
  end if;
end
$check$;
