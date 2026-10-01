-- A removed admin is not sent the digest: 0474's eligibility at admission. (API-96040DFB5635, JOB-EF2453D9F633)
--
-- On the fully replayed schema, as the roles Supabase uses:
--   shape    only the seven-argument admin_digest_begin_send exists (0471's six-argument
--            one is gone), and anon and authenticated cannot call it;
--   rules    a recipient on neither the allowlist (p_allowlisted) nor public.super_admins
--            is withdrawn under the live fence: terminal, with its bytes, key, attempts,
--            anchor and ambiguity kept. No later claim, mark or completion can use the
--            row, and not even the table owner can reopen it. A super_admins row matches
--            on the address trimmed (ASCII and Unicode whitespace) and lowercased.
--            p_allowlisted admits whatever the table holds; a NULL p_allowlisted is bad
--            input. A stale fence is refused before eligibility is read, so a stale worker
--            cannot withdraw. An unreadable super_admins fails the call and writes nothing.
-- Not shown here: a removal committed while an admission waits for the row lock. That
-- needs two sessions; tests/admin-digest-delivery-postgres.test.ts shows it on a
-- disposable database.
--
-- Rolled back: nothing here outlives the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

create or replace function public.admin_digest_now()
returns timestamptz language sql volatile set search_path = public, pg_temp
as $$ select coalesce(nullif(current_setting('admin_digest.test_now', true), '')::timestamptz, clock_timestamp()) $$;

-- One synthetic delivery, built exactly as the engine builds it (hash, recipient key, idempotency key).
create function pg_temp.delivery(occ text, addr text) returns jsonb language sql as $$
  select jsonb_build_object(
    'occurrenceId', occ, 'recipientKey', rk,
    'idempotencyKey', 'bubaly/admin-digest/v1/' || left(encode(sha256(convert_to(occ, 'UTF8')), 'hex'), 32) || '/' || left(rk, 32),
    'payloadJson', pj, 'payloadHash', encode(sha256(convert_to(pj, 'UTF8')), 'hex'))
  from (select encode(sha256(convert_to(addr, 'UTF8')), 'hex') as rk,
               json_build_object('from', 'Bubaly <digest@example.test>', 'to', addr, 'subject', 'Probe digest', 'html', '<p>2 new families.</p>')::text as pj) x
$$;
create function pg_temp.occurrence(occ text, deliveries jsonb) returns jsonb language sql as $$
  select jsonb_build_object('occurrenceId', occ,
    'window', jsonb_build_object('start', '2026-09-29T12:30:00Z', 'end', '2026-09-30T12:30:00Z'),
    'recipientKeys', (select jsonb_agg(d ->> 'recipientKey' order by d ->> 'recipientKey') from jsonb_array_elements(deliveries) d),
    'payloadHash', repeat('a', 64), 'engineVersion', 1)
$$;
create function pg_temp.row_of(loaded jsonb, k text) returns jsonb language sql as $$
  select d from jsonb_array_elements(loaded -> 'deliveries') d where d ->> 'recipientKey' = k
$$;

-- The probe's own super_admins rows, written untrimmed and mixed-case on purpose. Rows that
-- are already there are left alone: every address below is the probe's own.
insert into public.super_admins (email) values
  (E' Probe-Listed@Example.TEST\t'),
  (U&'\00A0\FEFFPROBE-NBSP@example.test\3000');

do $probe$
declare
  occ     text := 'admin-digest:probe-0474-2026-09-30T12:30:00.000Z';
  gone    jsonb := pg_temp.delivery(occ, 'probe-removed@example.test');
  listed  jsonb := pg_temp.delivery(occ, 'probe-listed@example.test');
  nbsp    jsonb := pg_temp.delivery(occ, 'probe-nbsp@example.test');
  conf    jsonb := pg_temp.delivery(occ, 'probe-allowlisted@example.test');
  amb     jsonb := pg_temp.delivery(occ, 'probe-ambiguous@example.test');
  sick    jsonb := pg_temp.delivery(occ, 'probe-unreadable@example.test');
  stale   jsonb := pg_temp.delivery(occ, 'probe-stale@example.test');
  every   jsonb;
  ret     bigint := 86400000;
  mar     bigint := 3600000;
  pin     timestamptz := '2026-09-30T12:31:00Z';
  res     jsonb;
  r       jsonb;
  txt     text;
  before  jsonb;
  refused boolean;
  rejected boolean;  -- bad input (invalid_parameter_value), not a privilege refusal
  failures int := 0;
begin
  perform set_config('admin_digest.test_now', pin::text, true);
  every := jsonb_build_array(gone, listed, nbsp, conf, amb, sick, stale);

  -- ── shape ────────────────────────────────────────────────────────────────
  if (select count(*) from pg_proc where proname = 'admin_digest_begin_send' and pronamespace = 'public'::regnamespace) <> 1
     or to_regprocedure('public.admin_digest_begin_send(text, text, bigint, integer, bigint, bigint, boolean)') is null then
    raise warning 'begin_send is not exactly the seven-argument function: the six-argument one survives, or the new one is missing';
    failures := failures + 1;
  end if;
  foreach txt in array array['anon', 'authenticated'] loop
    execute format('set local role %I', txt);
    refused := false;
    begin perform public.admin_digest_begin_send(occ, gone ->> 'recipientKey', 1, 150, ret, mar, true);
    exception when insufficient_privilege then refused := true; end;
    if not refused then raise warning 'LEAK: % calls admin_digest_begin_send', txt; failures := failures + 1; end if;
    reset role;
  end loop;

  set local role service_role;
  res := public.admin_digest_freeze(pg_temp.occurrence(occ, every), every);
  if not (res ->> 'created')::boolean then raise warning 'freeze did not store the plan: %', res; failures := failures + 1; end if;

  -- ── in neither: withdrawn under the live fence, for good ──────────────────
  res := public.admin_digest_claim(occ, gone ->> 'recipientKey', 'a', 300000, 3, ret, mar);
  if not (res ->> 'claimed')::boolean then raise warning 'claim: %', res; failures := failures + 1; end if;
  rejected := false;
  begin perform public.admin_digest_begin_send(occ, gone ->> 'recipientKey', 1, 150, ret, mar, null);
  exception when invalid_parameter_value then rejected := true; end;
  if not rejected then raise warning 'begin_send accepted a NULL allowlist answer'; failures := failures + 1; end if;
  res := public.admin_digest_begin_send(occ, gone ->> 'recipientKey', 1, 150, ret, mar, false);
  if res ->> 'answer' is distinct from 'withdrawn' then raise warning 'a recipient in neither was not withdrawn: %', res; failures := failures + 1; end if;
  r := pg_temp.row_of(public.admin_digest_load(occ), gone ->> 'recipientKey');
  if r ->> 'status' <> 'withdrawn' or (r ->> 'fence')::int <> 1 or (r ->> 'attempts')::int <> 1 or r ->> 'leaseOwner' is not null
     or r ->> 'sendStartedAt' is not null or r ->> 'firstSendAt' is not null or (r ->> 'ambiguous')::boolean
     or r ->> 'lastError' is distinct from 'recipient_no_longer_eligible'
     or r ->> 'payloadJson' <> gone ->> 'payloadJson' or r ->> 'idempotencyKey' <> gone ->> 'idempotencyKey' then
    raise warning 'the withdrawn row is not what 0474 writes: %', r; failures := failures + 1;
  end if;
  if public.admin_digest_complete(occ, gone ->> 'recipientKey', 1, '{"kind":"accepted","messageId":"m-late"}'::jsonb, 3) <> 'fenced_out' then
    raise warning 'the withdrawing claim completed a send'; failures := failures + 1;
  end if;
  res := public.admin_digest_claim(occ, gone ->> 'recipientKey', 'b', 300000, 3, ret, mar);
  if res ->> 'reason' is distinct from 'withdrawn' then raise warning 'a withdrawn row was claimed again: %', res; failures := failures + 1; end if;
  if public.admin_digest_begin_send(occ, gone ->> 'recipientKey', 1, 150, ret, mar, true) ->> 'answer' <> 'fenced_out' then
    raise warning 'a withdrawn row was marked'; failures := failures + 1;
  end if;

  -- ── in the table, as stored (untrimmed, mixed case): admitted ─────────────
  foreach txt in array array[listed ->> 'recipientKey', nbsp ->> 'recipientKey'] loop
    res := public.admin_digest_claim(occ, txt, 'a', 300000, 3, ret, mar);
    res := public.admin_digest_begin_send(occ, txt, 1, 150, ret, mar, false);
    if res ->> 'answer' is distinct from 'ok' then raise warning 'a super_admins row did not admit its normalised address: %', res; failures := failures + 1; end if;
  end loop;

  -- ── on the allowlist, not in the table: admitted ───────────────────────────
  res := public.admin_digest_claim(occ, conf ->> 'recipientKey', 'a', 300000, 3, ret, mar);
  res := public.admin_digest_begin_send(occ, conf ->> 'recipientKey', 1, 150, ret, mar, true);
  if res ->> 'answer' is distinct from 'ok' then raise warning 'p_allowlisted did not admit: %', res; failures := failures + 1; end if;

  -- ── a send that may have been accepted stays visible after withdrawal ─────
  res := public.admin_digest_claim(occ, amb ->> 'recipientKey', 'a', 300000, 3, ret, mar);
  res := public.admin_digest_begin_send(occ, amb ->> 'recipientKey', 1, 150, ret, mar, true);
  if public.admin_digest_complete(occ, amb ->> 'recipientKey', 1, '{"kind":"unknown","reason":"timeout"}'::jsonb, 3) <> 'ok' then
    raise warning 'ambiguous setup'; failures := failures + 1;
  end if;
  res := public.admin_digest_claim(occ, amb ->> 'recipientKey', 'b', 300000, 3, ret, mar);
  res := public.admin_digest_begin_send(occ, amb ->> 'recipientKey', 2, 150, ret, mar, false);
  r := pg_temp.row_of(public.admin_digest_load(occ), amb ->> 'recipientKey');
  if res ->> 'answer' is distinct from 'withdrawn' or r ->> 'status' <> 'withdrawn' or not (r ->> 'ambiguous')::boolean
     or r ->> 'firstSendAt' is null or (r ->> 'attempts')::int <> 2 then
    raise warning 'withdrawal hid an earlier possible send: % %', res, r; failures := failures + 1;
  end if;

  -- ── an unreadable super_admins fails the call and writes nothing ──────────
  res := public.admin_digest_claim(occ, sick ->> 'recipientKey', 'a', 300000, 3, ret, mar);
  before := pg_temp.row_of(public.admin_digest_load(occ), sick ->> 'recipientKey');
  reset role;
  alter table public.super_admins rename to super_admins_probe_unreadable;
  set local role service_role;
  foreach txt in array array['false', 'true'] loop
    refused := false;
    begin perform public.admin_digest_begin_send(occ, sick ->> 'recipientKey', 1, 150, ret, mar, txt::boolean);
    exception when undefined_table then refused := true; end;
    if not refused then raise warning 'begin_send answered without reading super_admins (p_allowlisted %)', txt; failures := failures + 1; end if;
  end loop;
  reset role;
  alter table public.super_admins_probe_unreadable rename to super_admins;
  set local role service_role;
  if pg_temp.row_of(public.admin_digest_load(occ), sick ->> 'recipientKey') is distinct from before then
    raise warning 'a failed admission wrote to the row'; failures := failures + 1;
  end if;

  -- ── a stale fence is refused before eligibility is read ───────────────────
  res := public.admin_digest_claim(occ, stale ->> 'recipientKey', 'a', 300000, 3, ret, mar);
  perform set_config('admin_digest.test_now', (pin + interval '5 minutes')::text, true);
  res := public.admin_digest_claim(occ, stale ->> 'recipientKey', 'b', 300000, 3, ret, mar);
  if public.admin_digest_begin_send(occ, stale ->> 'recipientKey', 1, 150, ret, mar, false) ->> 'answer' <> 'fenced_out' then
    raise warning 'a stale claimant withdrew'; failures := failures + 1;
  end if;
  r := pg_temp.row_of(public.admin_digest_load(occ), stale ->> 'recipientKey');
  if r ->> 'status' <> 'in_flight' or (r ->> 'fence')::int <> 2 or r ->> 'leaseOwner' <> 'b' then
    raise warning 'a stale admission changed the live claim: %', r; failures := failures + 1;
  end if;
  if public.admin_digest_begin_send(occ, stale ->> 'recipientKey', 2, 150, ret, mar, false) ->> 'answer' <> 'withdrawn' then
    raise warning 'the live claim did not withdraw'; failures := failures + 1;
  end if;
  reset role;

  -- ── a withdrawn row stays withdrawn, even for the owner ───────────────────
  refused := false;
  begin update public.admin_digest_deliveries set status = 'in_flight' where occurrence_id = occ and recipient_key = gone ->> 'recipientKey';
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise warning 'a withdrawn delivery was reopened'; failures := failures + 1; end if;

  if failures > 0 then
    raise exception 'the admin digest store does not withdraw as 0474 promises: % finding(s)', failures;
  end if;
  raise notice 'OK: only the seven-argument begin_send exists and anon and authenticated cannot call it; a recipient on neither the allowlist nor super_admins is withdrawn under the live fence and never claimed, marked, completed or reopened again; a super_admins row admits its trimmed, lowercased address; the allowlist admits on its own; withdrawal keeps ambiguity; an unreadable super_admins writes nothing; a stale claimant cannot withdraw.';
end
$probe$;

rollback;
