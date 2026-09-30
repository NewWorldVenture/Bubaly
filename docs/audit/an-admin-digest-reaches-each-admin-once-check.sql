-- An admin digest reaches each admin once: the 0471 delivery store. (API-96040DFB5635)
--
-- On the fully replayed schema, as the roles Supabase uses:
--   refused  anon and authenticated: every read, write and call;
--            service_role: every direct read or write of the two tables, and
--            the internal clock (it reaches the rows through the functions only);
--            anyone: changing a delivery's bytes or key, deleting a delivery,
--            changing or deleting an occurrence;
--   rules    freeze stores a plan once and never replaces it; one claim wins;
--            a superseded claim or a NULL fence cannot mark or complete; a completion needs a
--            mark; a lease that lapses after the mark makes the row ambiguous;
--            an ambiguous row is parked at retention minus margin, at claim and
--            at mark; too little lease left refuses the mark; a success without
--            a message id is not a receipt; a settled row stays settled.
-- Time is pinned for the transaction by replacing admin_digest_now() with a
-- version that reads a local setting; the replacement is rolled back with
-- everything else. The disposable-database suite
-- (tests/admin-digest-delivery-postgres.test.ts) adds real concurrency, crash
-- and restart evidence that one transaction cannot give.
--
-- Rolled back: nothing here outlives the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

create or replace function public.admin_digest_now()
returns timestamptz language sql volatile set search_path = public, pg_temp
as $$ select coalesce(nullif(current_setting('admin_digest.test_now', true), '')::timestamptz, clock_timestamp()) $$;

-- One synthetic delivery, built exactly as the engine builds it (hash, recipient key, idempotency key).
create function pg_temp.delivery(occ text, addr text, html text) returns jsonb language sql as $$
  select jsonb_build_object(
    'occurrenceId', occ, 'recipientKey', rk,
    'idempotencyKey', 'bubaly/admin-digest/v1/' || left(encode(sha256(convert_to(occ, 'UTF8')), 'hex'), 32) || '/' || left(rk, 32),
    'payloadJson', pj, 'payloadHash', encode(sha256(convert_to(pj, 'UTF8')), 'hex'))
  from (select encode(sha256(convert_to(addr, 'UTF8')), 'hex') as rk,
               json_build_object('from', 'Bubaly <digest@example.test>', 'to', addr, 'subject', 'Probe digest', 'html', html)::text as pj) x
$$;
create function pg_temp.occurrence(occ text, deliveries jsonb) returns jsonb language sql as $$
  select jsonb_build_object('occurrenceId', occ,
    'window', jsonb_build_object('start', '2026-09-29T12:30:00Z', 'end', '2026-09-30T12:30:00Z'),
    'recipientKeys', (select jsonb_agg(d ->> 'recipientKey' order by d ->> 'recipientKey') from jsonb_array_elements(deliveries) d),
    'payloadHash', repeat('a', 64), 'engineVersion', 1)
$$;

do $probe$
declare
  occ   text := 'admin-digest:probe-2026-09-30T12:30:00.000Z';
  one   jsonb := pg_temp.delivery(occ, 'probe-one@example.test', '<p>2 new families.</p>');
  two   jsonb := pg_temp.delivery(occ, 'probe-two@example.test', '<p>2 new families.</p>');
  k1    text := one ->> 'recipientKey';
  k2    text := two ->> 'recipientKey';
  ret   bigint := 86400000;
  mar   bigint := 3600000;
  res   jsonb;
  txt   text;
  refused boolean;
  rejected boolean;  -- bad input (invalid_parameter_value), not a privilege refusal
  failures int := 0;
  pin   timestamptz := '2026-09-30T12:31:00Z';
begin
  perform set_config('admin_digest.test_now', pin::text, true);

  -- ── anon and authenticated: nothing at all ─────────────────────────────────
  foreach txt in array array['anon', 'authenticated'] loop
    execute format('set local role %I', txt);
    refused := false;
    begin perform 1 from public.admin_digest_deliveries; exception when insufficient_privilege then refused := true; end;
    if not refused then raise warning 'LEAK: % reads admin_digest_deliveries', txt; failures := failures + 1; end if;
    refused := false;
    begin perform 1 from public.admin_digest_occurrences; exception when insufficient_privilege then refused := true; end;
    if not refused then raise warning 'LEAK: % reads admin_digest_occurrences', txt; failures := failures + 1; end if;
    refused := false;
    begin perform public.admin_digest_load(occ); exception when insufficient_privilege then refused := true; end;
    if not refused then raise warning 'LEAK: % calls admin_digest_load', txt; failures := failures + 1; end if;
    refused := false;
    begin perform public.admin_digest_claim(occ, k1, 'x', 1000, 1, ret, mar); exception when insufficient_privilege then refused := true; end;
    if not refused then raise warning 'LEAK: % calls admin_digest_claim', txt; failures := failures + 1; end if;
    refused := false;
    begin perform public.admin_digest_freeze('{}'::jsonb, '[]'::jsonb); exception when insufficient_privilege then refused := true; end;
    if not refused then raise warning 'LEAK: % calls admin_digest_freeze', txt; failures := failures + 1; end if;
    reset role;
  end loop;

  -- ── the service role: the functions, and nothing direct ────────────────────
  set local role service_role;
  refused := false;
  begin perform 1 from public.admin_digest_deliveries; exception when insufficient_privilege then refused := true; end;
  if not refused then raise warning 'WIDE: service_role reads admin_digest_deliveries directly'; failures := failures + 1; end if;
  refused := false;
  begin update public.admin_digest_deliveries set status = 'accepted'; exception when insufficient_privilege then refused := true; end;
  if not refused then raise warning 'WIDE: service_role writes admin_digest_deliveries directly'; failures := failures + 1; end if;
  refused := false;
  begin perform public.admin_digest_now(); exception when insufficient_privilege then refused := true; end;
  if not refused then raise warning 'WIDE: service_role calls the internal clock'; failures := failures + 1; end if;

  res := public.admin_digest_freeze(pg_temp.occurrence(occ, jsonb_build_array(one, two)), jsonb_build_array(one, two));
  if not (res ->> 'created')::boolean or jsonb_array_length(res -> 'deliveries') <> 2 then
    raise warning 'freeze did not store the plan: %', res; failures := failures + 1;
  end if;
  -- A second, DIFFERENT plan for the same occurrence changes nothing.
  res := public.admin_digest_freeze(pg_temp.occurrence(occ, jsonb_build_array(pg_temp.delivery(occ, 'probe-one@example.test', '<p>9 new families.</p>'))),
                                    jsonb_build_array(pg_temp.delivery(occ, 'probe-one@example.test', '<p>9 new families.</p>')));
  if (res ->> 'created')::boolean or jsonb_array_length(res -> 'deliveries') <> 2
     or (res -> 'deliveries' -> 0 ->> 'payloadJson') like '%9 new%' or (res -> 'deliveries' -> 1 ->> 'payloadJson') like '%9 new%' then
    raise warning 'a second freeze replaced the stored plan: %', res; failures := failures + 1;
  end if;

  -- One claim wins; a superseded claim cannot mark or complete; a completion needs a mark.
  res := public.admin_digest_claim(occ, k1, 'a', 300000, 3, ret, mar);
  if not (res ->> 'claimed')::boolean or (res #>> '{row,fence}')::int <> 1 then raise warning 'first claim: %', res; failures := failures + 1; end if;
  res := public.admin_digest_claim(occ, k1, 'b', 300000, 3, ret, mar);
  if res ->> 'reason' is distinct from 'leased' then raise warning 'a live lease did not refuse: %', res; failures := failures + 1; end if;
  -- A NULL fence is bad input, never a match; the unmarked-completion check below also proves it wrote no mark.
  rejected := false;
  begin perform public.admin_digest_begin_send(occ, k1, null, 150, ret, mar); exception when invalid_parameter_value then rejected := true; end;
  if not rejected then raise warning 'begin_send accepted a NULL fence'; failures := failures + 1; end if;
  if public.admin_digest_complete(occ, k1, 1, '{"kind":"unknown","reason":"timeout"}', 3) <> 'fenced_out' then
    raise warning 'a completion without a mark was accepted'; failures := failures + 1;
  end if;
  if public.admin_digest_begin_send(occ, k1, 0, 150, ret, mar) ->> 'answer' <> 'fenced_out' then raise warning 'a stale fence marked'; failures := failures + 1; end if;
  if public.admin_digest_begin_send(occ, k1, 1, 150, ret, mar) ->> 'answer' <> 'ok' then raise warning 'the current fence could not mark'; failures := failures + 1; end if;
  -- The completion below succeeding proves this one wrote nothing.
  rejected := false;
  begin perform public.admin_digest_complete(occ, k1, null, '{"kind":"accepted","messageId":"msg-forged"}', 3); exception when invalid_parameter_value then rejected := true; end;
  if not rejected then raise warning 'complete accepted a NULL fence'; failures := failures + 1; end if;
  if public.admin_digest_complete(occ, k1, 1, '{"kind":"accepted","messageId":""}', 3) <> 'ok' then raise warning 'complete refused'; failures := failures + 1; end if;
  res := public.admin_digest_load(occ);
  if (res -> 'deliveries') @> jsonb_build_array(jsonb_build_object('recipientKey', k1, 'status', 'accepted')) then
    raise warning 'a success without a message id became a receipt'; failures := failures + 1;
  end if;

  -- The retention cut-off (24 h − 1 h after the first mark) parks an ambiguous row at claim.
  perform set_config('admin_digest.test_now', (pin + interval '23 hours')::text, true);
  res := public.admin_digest_claim(occ, k1, 'c', 300000, 3, ret, mar);
  if res ->> 'reason' is distinct from 'needs_reconciliation' then raise warning 'retention did not park: %', res; failures := failures + 1; end if;

  -- A lease that lapses after a mark makes the row ambiguous; too little lease refuses the mark.
  res := public.admin_digest_claim(occ, k2, 'a', 300000, 3, ret, mar);
  if public.admin_digest_begin_send(occ, k2, 1, 150, ret, mar) ->> 'answer' <> 'ok' then raise warning 'k2 mark'; failures := failures + 1; end if;
  perform set_config('admin_digest.test_now', (pin + interval '23 hours 5 minutes 1 second')::text, true);
  res := public.admin_digest_claim(occ, k2, 'b', 300000, 3, ret, mar);
  if not (res #>> '{row,ambiguous}')::boolean or (res #>> '{row,fence}')::int <> 2 then raise warning 'a lapsed marked lease was not ambiguous: %', res; failures := failures + 1; end if;
  perform set_config('admin_digest.test_now', (pin + interval '23 hours 10 minutes 0.9 seconds')::text, true);
  if public.admin_digest_begin_send(occ, k2, 2, 150, ret, mar) ->> 'answer' <> 'lease_expired' then raise warning 'a nearly lapsed lease still marked'; failures := failures + 1; end if;
  reset role;

  -- ── frozen means frozen, for everyone (these are the owner's own writes) ────
  refused := false;
  begin update public.admin_digest_deliveries set payload_json = replace(payload_json, '2 new', '9 new') where occurrence_id = occ;
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise warning 'a delivery''s bytes changed after freeze'; failures := failures + 1; end if;
  refused := false;
  begin delete from public.admin_digest_deliveries where occurrence_id = occ; exception when insufficient_privilege then refused := true; end;
  if not refused then raise warning 'a delivery was deleted'; failures := failures + 1; end if;
  refused := false;
  begin update public.admin_digest_occurrences set window_end = window_end + interval '1 day' where occurrence_id = occ;
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise warning 'an occurrence changed after freeze'; failures := failures + 1; end if;
  refused := false;
  begin update public.admin_digest_deliveries set status = 'pending' where occurrence_id = occ and recipient_key = k1;
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise warning 'a settled delivery was reopened'; failures := failures + 1; end if;

  if failures > 0 then
    raise exception 'the admin digest delivery store is not what 0471 promises: % finding(s)', failures;
  end if;
  raise notice 'OK: anon and authenticated reach nothing; service_role reaches the rows only through the functions; a plan is frozen once; one claim wins; stale fences, unmarked completions and short leases are refused; ambiguity parks at the retention cut-off; bytes, keys, occurrences and settled rows never change.';
end
$probe$;

rollback;
