-- Behavioural proof for 0337: one Resend event moves a campaign counter once.
--
-- Before 0337 the webhook incremented the counter and THEN finalised the
-- receipt; a failed finalisation released the claim, the provider retried, and
-- the same event was counted twice. apply_resend_campaign_counter() marks the
-- receipt and increments in one transaction, only for the claim holder.

do $$
declare
  campaign uuid;
  claimed  timestamptz := '2026-09-26 12:00:00+00';
  outcome  text;
  n        int;
  refused  boolean;
begin
  insert into public.marketing_email_campaigns (subject)
    values ('Counter probe') returning id into campaign;
  insert into public.resend_webhook_events (svix_id, event_type, status, received_at)
    values ('msg_counter_probe_1', 'email.opened', 'processing', claimed);

  -- 1. The claim holder counts the event.
  outcome := public.apply_resend_campaign_counter('msg_counter_probe_1', claimed, campaign::text, 'opens');
  if outcome <> 'applied' then raise exception 'first application answered %', outcome; end if;

  -- 2. Finalisation "fails", the claim is released and re-taken by a retry —
  --    the exact path that used to count twice.
  update public.resend_webhook_events set status = 'error' where svix_id = 'msg_counter_probe_1';
  update public.resend_webhook_events set status = 'processing', received_at = claimed + interval '1 minute'
   where svix_id = 'msg_counter_probe_1';
  outcome := public.apply_resend_campaign_counter('msg_counter_probe_1', claimed + interval '1 minute', campaign::text, 'opens');
  if outcome <> 'already_applied' then raise exception 'a retried event answered % instead of already_applied', outcome; end if;

  select coalesce(opens, 0) into n from public.marketing_email_campaigns where id = campaign;
  if n <> 1 then raise exception 'one opened event counted % times', n; end if;

  -- 3. A worker that no longer holds the claim counts nothing.
  insert into public.resend_webhook_events (svix_id, event_type, status, received_at)
    values ('msg_counter_probe_2', 'email.clicked', 'processing', claimed);
  outcome := public.apply_resend_campaign_counter('msg_counter_probe_2', claimed - interval '1 minute', campaign::text, 'clicks');
  if outcome <> 'claim_lost' then raise exception 'a stale worker answered %', outcome; end if;
  select coalesce(clicks, 0) into n from public.marketing_email_campaigns where id = campaign;
  if n <> 0 then raise exception 'a stale worker moved the click counter'; end if;

  -- 4. The holder of that claim still counts it; an unknown campaign is left alone.
  outcome := public.apply_resend_campaign_counter('msg_counter_probe_2', claimed, campaign::text, 'clicks');
  if outcome <> 'applied' then raise exception 'the claim holder answered %', outcome; end if;
  insert into public.resend_webhook_events (svix_id, event_type, status, received_at)
    values ('msg_counter_probe_3', 'email.opened', 'processing', claimed);
  outcome := public.apply_resend_campaign_counter('msg_counter_probe_3', claimed, gen_random_uuid()::text, 'opens');
  if outcome <> 'no_campaign' then raise exception 'an unknown campaign answered %', outcome; end if;

  -- 5. Only a counter column may be named.
  refused := false;
  begin
    perform public.apply_resend_campaign_counter('msg_counter_probe_3', claimed, campaign::text, 'name');
  exception when invalid_parameter_value then refused := true;
  end;
  if not refused then raise exception 'a non-counter column was accepted as a counter'; end if;

  -- 6. No session may call it.
  if has_function_privilege('authenticated', 'public.apply_resend_campaign_counter(text, timestamptz, text, text)', 'execute')
     or has_function_privilege('anon', 'public.apply_resend_campaign_counter(text, timestamptz, text, text)', 'execute') then
    raise exception 'a client session can move campaign counters';
  end if;

  raise notice 'OK  one Resend event moves a campaign counter once, and only for its claim holder';
end $$;
