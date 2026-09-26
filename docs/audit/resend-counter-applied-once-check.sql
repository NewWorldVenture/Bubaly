-- A campaign counter moves once per webhook event. (EMAIL-002, migration 0340)
--
-- The webhook's counter moved before its receipt was finalised, so a failed
-- finalisation was retried and counted the same open twice.
-- resend_apply_campaign_counter marks the event and increments the campaign in
-- one transaction, so a retry of an applied event changes nothing.
--
--   the same event applied twice                      -> counted once
--   two different events for one campaign             -> counted twice
--   a malformed campaign tag                          -> no_campaign, no marker lost
--   an unknown counter name                           -> refused
--   an event that was never claimed                   -> refused
--   a signed-in member calling it                     -> REFUSED
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  campaign uuid := '00000000-0000-4000-8000-00000000f701';
  member   uuid := '00000000-0000-4000-8000-00000000f702';
  outcome  text;
  opens    int;
  refused  boolean;
  failures int := 0;
begin
  insert into public.marketing_email_campaigns (id) values (campaign)
  on conflict (id) do update set opens = 0;
  update public.marketing_email_campaigns set opens = 0 where id = campaign;
  insert into public.resend_webhook_events (svix_id, event_type, status, received_at) values
    ('msg_probe_a', 'email.opened', 'processing', now()),
    ('msg_probe_b', 'email.opened', 'processing', now()),
    ('msg_probe_c', 'email.opened', 'processing', now())
  on conflict (svix_id) do update set counter_applied_at = null;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;

  -- 1. the same event twice (a retry after a failed finalisation)
  outcome := public.resend_apply_campaign_counter('msg_probe_a', campaign::text, 'opens');
  if outcome <> 'applied' then raise exception 'CONTROL FAILED: first application answered %', outcome; end if;
  outcome := public.resend_apply_campaign_counter('msg_probe_a', campaign::text, 'opens');
  if outcome <> 'already_applied' then raise warning 'BREACH: a retried event answered %', outcome; failures := failures + 1; end if;
  select m.opens into opens from public.marketing_email_campaigns m where m.id = campaign;
  if opens <> 1 then raise warning 'BREACH: one event counted % times', opens; failures := failures + 1; end if;

  -- 2. a second, different event still counts
  outcome := public.resend_apply_campaign_counter('msg_probe_b', campaign::text, 'opens');
  select m.opens into opens from public.marketing_email_campaigns m where m.id = campaign;
  if outcome <> 'applied' or opens <> 2 then raise warning 'BREACH: a second event was not counted (%, opens %)', outcome, opens; failures := failures + 1; end if;

  -- 3. a malformed campaign tag is an unknown campaign, not an error
  outcome := public.resend_apply_campaign_counter('msg_probe_c', 'not-a-campaign', 'opens');
  if outcome <> 'no_campaign' then raise warning 'BREACH: a malformed tag answered %', outcome; failures := failures + 1; end if;

  -- 4-5. an unknown counter and an unclaimed event are refused
  refused := false;
  begin perform public.resend_apply_campaign_counter('msg_probe_c', campaign::text, 'revenue');
  exception when invalid_parameter_value then refused := true; end;
  if not refused then raise warning 'BREACH: an unknown counter name was accepted'; failures := failures + 1; end if;
  refused := false;
  begin perform public.resend_apply_campaign_counter('msg_never_claimed', campaign::text, 'opens');
  exception when no_data_found then refused := true; end;
  if not refused then raise warning 'BREACH: an unclaimed event moved a counter'; failures := failures + 1; end if;
  reset role;

  -- 6. a signed-in member cannot call it
  perform set_config('request.jwt.claims', json_build_object('sub', member::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  refused := false;
  begin perform public.resend_apply_campaign_counter('msg_probe_c', campaign::text, 'opens');
  exception when insufficient_privilege then refused := true; end;
  reset role;
  if not refused then raise warning 'BREACH: a signed-in member could move a campaign counter'; failures := failures + 1; end if;

  if failures > 0 then
    raise exception 'resend-counter: % assertion(s) failed', failures;
  end if;
  raise notice 'OK: each webhook event moves its campaign counter once, and only the service role can move it.';
end
$probe$;

rollback;
