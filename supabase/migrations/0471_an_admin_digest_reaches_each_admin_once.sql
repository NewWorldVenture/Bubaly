-- Bubaly :: 0471 - an admin digest reaches each admin once
--                   (API-96040DFB5635, JOB-EF2453D9F633; number reserved on #699)
-- ----------------------------------------------------------------------------
-- The delivery store for lib/admin/digest-delivery.ts, the per-recipient
-- engine. NOTHING CALLS IT YET: no route or scheduler is wired to the engine,
-- and this migration is not applied to production (docs/PENDING_PROD_MIGRATIONS.md;
-- production's ledger stops at 0177, PROD-DB-0177).
--
-- Why a ledger at all. /api/cron/admin-digest writes nothing, so it cannot tell
-- a first delivery from a repeat: two ticks, or a retry after one admin failed,
-- send everyone the digest again (tests/admin-digest-replay-contract.test.ts,
-- #677). The engine fixes that with one row per (occurrence, recipient) that
-- holds the recipient's stable idempotency key and the EXACT bytes that will be
-- sent, written before anything is sent, and a small state machine that is
-- advanced only by the four functions below.
--
-- Each function is the SQL twin of one pure rule in lib/admin/digest-delivery.ts
-- and must stay equal to it (docs/admin-digest-delivery-contract.md §3; the
-- store contract suite runs against both):
--
--   admin_digest_freeze      store the plan once; a later plan never replaces it
--   admin_digest_claim       decideClaim      (row lock, lease, fence, retention)
--   admin_digest_begin_send  decideBeginSend  (fence, remaining lease, retention)
--   admin_digest_complete    decideCompletion (fenced; only a message id is a receipt)
--
-- Time. Every lease and retention decision reads admin_digest_now() AFTER the
-- row lock is taken. It is clock_timestamp(), not now(): now() is the
-- transaction's start and can be stale after a lock wait. One function so the
-- disposable test database can pin it; nothing in production redefines it.
--
-- Frozen means frozen, and the database says so, not only the code:
--   - a delivery's key, bytes, hash and recipient never change after insert,
--     and they must agree with each other on insert (the hash is the sha256 of
--     the bytes, the recipient key is the sha256 of the bytes' `to`, the key is
--     the engine's formula);
--   - a terminal row (accepted, rejected, conflict, exhausted,
--     needs_reconciliation) never leaves its state, attempts and the fence
--     never go down, and "ambiguous" is never cleared;
--   - rows are never deleted: a deleted receipt is a resend.
--
-- Access: the service role, through the functions only. RLS on with no
-- policies; every table privilege revoked from anon, authenticated AND
-- service_role; EXECUTE on the five API functions granted to service_role
-- alone. No client ever reads a digest's recipients or body, and no direct
-- write can skip a rule.
--
-- Probe: docs/audit/an-admin-digest-reaches-each-admin-once-check.sql.

create table if not exists public.admin_digest_occurrences (
  occurrence_id   text primary key check (length(occurrence_id) between 1 and 200 and occurrence_id ~ '^[!-~]([ -~]*[!-~])?$'),
  window_start    timestamptz not null,
  window_end      timestamptz not null,
  recipient_keys  text[] not null check (cardinality(recipient_keys) between 1 and 200),
  payload_hash    text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  engine_version  integer not null check (engine_version >= 1),
  frozen_at       timestamptz not null,
  check (window_end > window_start)
);

create table if not exists public.admin_digest_deliveries (
  occurrence_id        text not null references public.admin_digest_occurrences (occurrence_id) on delete restrict,
  recipient_key        text not null check (recipient_key ~ '^[0-9a-f]{64}$'),
  idempotency_key      text not null unique check (length(idempotency_key) between 1 and 256 and idempotency_key ~ '^[!-~]([ -~]*[!-~])?$'),
  payload_json         text not null check (length(payload_json) between 2 and 600000),
  payload_hash         text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  status               text not null check (status in ('pending', 'in_flight', 'failed', 'unknown', 'accepted', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation')),
  attempts             integer not null default 0 check (attempts >= 0),
  fence                bigint not null default 0 check (fence >= 0),
  lease_owner          text check (lease_owner is null or length(lease_owner) between 1 and 200),
  lease_expires_at     timestamptz,
  send_started_at      timestamptz,
  first_send_at        timestamptz,
  ambiguous            boolean not null default false,
  provider_message_id  text check (provider_message_id is null or length(provider_message_id) between 1 and 200),
  last_error           text check (last_error is null or length(last_error) <= 200),
  updated_at           timestamptz not null,
  primary key (occurrence_id, recipient_key),
  check ((status = 'in_flight') = (lease_owner is not null and lease_expires_at is not null)),
  check ((status = 'accepted') = (provider_message_id is not null)),
  check (send_started_at is null or status = 'in_flight'),
  check (not ambiguous or first_send_at is not null)
);

alter table public.admin_digest_occurrences enable row level security;
alter table public.admin_digest_deliveries enable row level security;
-- Narrow even for the service role: it reaches these rows only through the four
-- functions below, so no direct write can skip a rule.
revoke all on public.admin_digest_occurrences from anon, authenticated, service_role;
revoke all on public.admin_digest_deliveries from anon, authenticated, service_role;

-- ── the one clock ────────────────────────────────────────────────────────────
create or replace function public.admin_digest_now()
returns timestamptz
language sql
volatile
set search_path = public, pg_temp
as $$ select clock_timestamp() $$;

-- ── frozen identity and a transition-only ledger ────────────────────────────
create or replace function public.admin_digest_delivery_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  to_addr text;
begin
  if tg_op = 'DELETE' then
    raise exception 'admin_digest_deliveries rows are never deleted: a deleted receipt is a resend' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    begin
      to_addr := (new.payload_json::jsonb) ->> 'to';
    exception when others then
      raise exception 'admin_digest_deliveries.payload_json must be a JSON object' using errcode = '22023';
    end;
    if new.payload_hash <> encode(sha256(convert_to(new.payload_json, 'UTF8')), 'hex') then
      raise exception 'admin_digest_deliveries.payload_hash is not the sha256 of payload_json' using errcode = '22023';
    end if;
    if to_addr is null or new.recipient_key <> encode(sha256(convert_to(to_addr, 'UTF8')), 'hex') then
      raise exception 'admin_digest_deliveries.recipient_key is not the sha256 of the payload''s recipient' using errcode = '22023';
    end if;
    if new.idempotency_key <> 'bubaly/admin-digest/v1/' || left(encode(sha256(convert_to(new.occurrence_id, 'UTF8')), 'hex'), 32) || '/' || left(new.recipient_key, 32) then
      raise exception 'admin_digest_deliveries.idempotency_key is not the key for (occurrence, recipient)' using errcode = '22023';
    end if;
    if new.status <> 'pending' or new.attempts <> 0 or new.fence <> 0 or new.ambiguous or new.first_send_at is not null
       or new.provider_message_id is not null then
      raise exception 'an admin digest delivery starts pending, unattempted' using errcode = '22023';
    end if;
    return new;
  end if;
  -- UPDATE
  if new.occurrence_id is distinct from old.occurrence_id or new.recipient_key is distinct from old.recipient_key
     or new.idempotency_key is distinct from old.idempotency_key or new.payload_json is distinct from old.payload_json
     or new.payload_hash is distinct from old.payload_hash then
    raise exception 'a frozen admin digest delivery keeps its recipient, key and bytes' using errcode = '42501';
  end if;
  if old.status in ('accepted', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation') and new.status is distinct from old.status then
    raise exception 'a settled admin digest delivery (%) stays settled', old.status using errcode = '42501';
  end if;
  if new.attempts < old.attempts or new.fence < old.fence or (old.ambiguous and not new.ambiguous)
     or (old.first_send_at is not null and new.first_send_at is distinct from old.first_send_at) then
    raise exception 'attempts, fence, ambiguity and the retention anchor only move forward' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists admin_digest_delivery_guard on public.admin_digest_deliveries;
create trigger admin_digest_delivery_guard
  before insert or update or delete on public.admin_digest_deliveries
  for each row execute function public.admin_digest_delivery_guard();

create or replace function public.admin_digest_occurrence_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'a frozen admin digest occurrence is never changed or deleted' using errcode = '42501';
end $$;

drop trigger if exists admin_digest_occurrence_guard on public.admin_digest_occurrences;
create trigger admin_digest_occurrence_guard
  before update or delete on public.admin_digest_occurrences
  for each row execute function public.admin_digest_occurrence_guard();

-- ── JSON shapes the adapter reads (camelCase, as lib/admin/digest-delivery.ts names them) ──
create or replace function public.admin_digest_delivery_json(r public.admin_digest_deliveries)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'occurrenceId', r.occurrence_id, 'recipientKey', r.recipient_key, 'idempotencyKey', r.idempotency_key,
    'payloadJson', r.payload_json, 'payloadHash', r.payload_hash, 'status', r.status, 'attempts', r.attempts,
    'fence', r.fence, 'leaseOwner', r.lease_owner, 'leaseExpiresAt', r.lease_expires_at,
    'sendStartedAt', r.send_started_at, 'firstSendAt', r.first_send_at, 'ambiguous', r.ambiguous,
    'providerMessageId', r.provider_message_id, 'lastError', r.last_error, 'updatedAt', r.updated_at)
$$;

create or replace function public.admin_digest_load(p_occurrence_id text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'occurrence', jsonb_build_object(
      'occurrenceId', o.occurrence_id,
      'window', jsonb_build_object('start', o.window_start, 'end', o.window_end),
      'recipientKeys', to_jsonb(o.recipient_keys), 'payloadHash', o.payload_hash, 'engineVersion', o.engine_version),
    'deliveries', coalesce((
      select jsonb_agg(public.admin_digest_delivery_json(d) order by d.recipient_key)
      from public.admin_digest_deliveries d where d.occurrence_id = o.occurrence_id), '[]'::jsonb))
  from public.admin_digest_occurrences o
  where o.occurrence_id = p_occurrence_id
$$;

-- ── freeze: the plan is stored once; a later plan never replaces it ─────────
create or replace function public.admin_digest_freeze(p_occurrence jsonb, p_deliveries jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_id    text := p_occurrence ->> 'occurrenceId';
  v_now   timestamptz := public.admin_digest_now();
  v_keys  text[];
  won     int;
  stored  jsonb;
begin
  if v_id is null or jsonb_typeof(p_deliveries) <> 'array' then
    raise exception 'admin_digest_freeze: an occurrence id and a deliveries array are required' using errcode = '22023';
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_keys from jsonb_array_elements_text(p_occurrence -> 'recipientKeys') k;
  insert into public.admin_digest_occurrences (occurrence_id, window_start, window_end, recipient_keys, payload_hash, engine_version, frozen_at)
  values (v_id, (p_occurrence #>> '{window,start}')::timestamptz, (p_occurrence #>> '{window,end}')::timestamptz,
          v_keys, p_occurrence ->> 'payloadHash', (p_occurrence ->> 'engineVersion')::int, v_now)
  on conflict (occurrence_id) do nothing;
  get diagnostics won = row_count;
  if won = 1 then
    insert into public.admin_digest_deliveries (occurrence_id, recipient_key, idempotency_key, payload_json, payload_hash, status, updated_at)
    select v_id, d ->> 'recipientKey', d ->> 'idempotencyKey', d ->> 'payloadJson', d ->> 'payloadHash', 'pending', v_now
    from jsonb_array_elements(p_deliveries) d
    where d ->> 'occurrenceId' = v_id;
    -- All or nothing: exactly one delivery per frozen recipient key, for this occurrence.
    if (select count(*) from public.admin_digest_deliveries where occurrence_id = v_id) <> cardinality(v_keys)
       or jsonb_array_length(p_deliveries) <> cardinality(v_keys)
       or exists (select 1 from public.admin_digest_deliveries d where d.occurrence_id = v_id and not d.recipient_key = any (v_keys)) then
      raise exception 'admin_digest_freeze: deliveries do not match the occurrence' using errcode = '22023';
    end if;
  end if;
  stored := public.admin_digest_load(v_id);
  return stored || jsonb_build_object('created', won = 1);
end $$;

-- ── claim: decideClaim, evaluated after the row lock with the database clock ──
create or replace function public.admin_digest_claim(
  p_occurrence_id text, p_recipient_key text, p_owner text,
  p_lease_ms integer, p_max_attempts integer, p_retention_ms bigint, p_margin_ms bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  r      public.admin_digest_deliveries%rowtype;
  v_now  timestamptz;
begin
  if p_owner is null or length(p_owner) not between 1 and 200 or p_lease_ms is null or p_lease_ms < 1
     or p_max_attempts is null or p_max_attempts < 1 or p_retention_ms is null or p_margin_ms is null
     or p_margin_ms < 1 or p_margin_ms >= p_retention_ms or p_retention_ms > 86400000
     or p_lease_ms >= p_retention_ms - p_margin_ms then
    raise exception 'admin_digest_claim: bad owner, lease, attempts or retention' using errcode = '22023';
  end if;
  select * into r from public.admin_digest_deliveries
   where occurrence_id = p_occurrence_id and recipient_key = p_recipient_key
   for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'not_found');
  end if;
  v_now := public.admin_digest_now();  -- after the lock: a lock wait must not age the decision
  if r.status in ('accepted', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation') then
    return jsonb_build_object('claimed', false, 'reason', r.status);
  end if;
  if r.status = 'in_flight' then
    if r.lease_expires_at is not null and r.lease_expires_at > v_now then
      return jsonb_build_object('claimed', false, 'reason', 'leased');
    end if;
    -- The worker died or stalled. With a beginSend mark it may have reached the provider.
    if r.send_started_at is not null then
      r.ambiguous := true;
      r.status := 'unknown';
      r.last_error := 'lease_expired_after_send_started';
    else
      r.status := case when r.ambiguous then 'unknown' when r.attempts > 1 then 'failed' else 'pending' end;
      r.last_error := 'lease_expired_before_send';
    end if;
    r.lease_owner := null;
    r.lease_expires_at := null;
    r.send_started_at := null;
  end if;
  if r.attempts >= p_max_attempts
     or (r.ambiguous and (r.first_send_at is null
         or v_now >= r.first_send_at + make_interval(secs => (p_retention_ms - p_margin_ms) / 1000.0))) then
    -- Parked: attempts used up, or an ambiguous row past its retention cut-off.
    r.status := case when r.ambiguous then 'needs_reconciliation' else 'exhausted' end;
    update public.admin_digest_deliveries set
      status = r.status, lease_owner = null, lease_expires_at = null, send_started_at = null,
      ambiguous = r.ambiguous, last_error = r.last_error, updated_at = v_now
     where occurrence_id = p_occurrence_id and recipient_key = p_recipient_key;
    return jsonb_build_object('claimed', false, 'reason', r.status);
  end if;
  update public.admin_digest_deliveries set
    status = 'in_flight', attempts = r.attempts + 1, fence = r.fence + 1, lease_owner = p_owner,
    lease_expires_at = v_now + make_interval(secs => p_lease_ms / 1000.0), send_started_at = null,
    ambiguous = r.ambiguous, last_error = r.last_error, updated_at = v_now
   where occurrence_id = p_occurrence_id and recipient_key = p_recipient_key
  returning * into r;
  return jsonb_build_object('claimed', true, 'row', public.admin_digest_delivery_json(r));
end $$;

-- ── beginSend: decideBeginSend, the last check before the provider call ─────
-- A granted mark answers {"answer":"ok","dispatchBy":…}: the provider call must START before
-- then (lease minus the send deadline; for an ambiguous row also the first mark plus retention
-- minus margin), and the engine re-reads its clock after this answer arrives, so a late answer
-- cannot send late.
create or replace function public.admin_digest_begin_send(
  p_occurrence_id text, p_recipient_key text, p_fence bigint,
  p_min_lease_ms integer, p_retention_ms bigint, p_margin_ms bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  r      public.admin_digest_deliveries%rowtype;
  v_now  timestamptz;
begin
  if p_min_lease_ms is null or p_min_lease_ms < 0 or p_retention_ms is null or p_margin_ms is null
     or p_margin_ms < 1 or p_margin_ms >= p_retention_ms or p_retention_ms > 86400000 then
    raise exception 'admin_digest_begin_send: bad lease or retention' using errcode = '22023';
  end if;
  select * into r from public.admin_digest_deliveries
   where occurrence_id = p_occurrence_id and recipient_key = p_recipient_key
   for update;
  if not found or r.status <> 'in_flight' or r.fence <> p_fence then
    return jsonb_build_object('answer', 'fenced_out');
  end if;
  v_now := public.admin_digest_now();
  if r.lease_expires_at is null or r.lease_expires_at - v_now <= make_interval(secs => p_min_lease_ms / 1000.0) then
    return jsonb_build_object('answer', 'lease_expired');  -- left for the next claim; nothing is written
  end if;
  if r.ambiguous and (r.first_send_at is null
     or v_now >= r.first_send_at + make_interval(secs => (p_retention_ms - p_margin_ms) / 1000.0)) then
    update public.admin_digest_deliveries set
      status = 'needs_reconciliation', lease_owner = null, lease_expires_at = null, send_started_at = null, updated_at = v_now
     where occurrence_id = p_occurrence_id and recipient_key = p_recipient_key;
    return jsonb_build_object('answer', 'retention_passed');
  end if;
  update public.admin_digest_deliveries set
    send_started_at = v_now, first_send_at = coalesce(r.first_send_at, v_now), updated_at = v_now
   where occurrence_id = p_occurrence_id and recipient_key = p_recipient_key;
  -- The retention part binds only an ambiguous row: one only ever refused has nothing to duplicate.
  return jsonb_build_object('answer', 'ok', 'dispatchBy', case when r.ambiguous then least(
      r.lease_expires_at - make_interval(secs => p_min_lease_ms / 1000.0),
      coalesce(r.first_send_at, v_now) + make_interval(secs => (p_retention_ms - p_margin_ms) / 1000.0))
    else r.lease_expires_at - make_interval(secs => p_min_lease_ms / 1000.0) end);
end $$;

-- ── complete: decideCompletion, fenced, after a mark; only a message id is a receipt ──
create or replace function public.admin_digest_complete(
  p_occurrence_id text, p_recipient_key text, p_fence bigint, p_result jsonb, p_max_attempts integer
) returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  r       public.admin_digest_deliveries%rowtype;
  v_now   timestamptz;
  v_kind  text := p_result ->> 'kind';
  v_mid   text := p_result ->> 'messageId';
begin
  if p_max_attempts is null or p_max_attempts < 1
     or v_kind is null or v_kind not in ('accepted', 'rejected', 'payload_conflict', 'in_progress', 'unknown') then
    raise exception 'admin_digest_complete: bad result or attempts' using errcode = '22023';
  end if;
  select * into r from public.admin_digest_deliveries
   where occurrence_id = p_occurrence_id and recipient_key = p_recipient_key
   for update;
  -- Fenced, and only after a mark: a claim that never marked a send owns no provider answer.
  if not found or r.status <> 'in_flight' or r.fence <> p_fence or r.send_started_at is null then
    return 'fenced_out';
  end if;
  v_now := public.admin_digest_now();
  r.lease_owner := null;
  r.lease_expires_at := null;
  r.send_started_at := null;
  if v_kind = 'accepted' and coalesce(v_mid, '') <> '' then
    r.status := 'accepted'; r.provider_message_id := left(v_mid, 200); r.last_error := null;
  elsif v_kind = 'accepted' then
    r.ambiguous := true; r.status := 'unknown'; r.last_error := 'outcome_unknown:unreadable_response';
  elsif v_kind = 'payload_conflict' then
    r.status := 'conflict'; r.last_error := 'provider_payload_conflict';
  elsif v_kind = 'rejected' then
    r.last_error := left('provider_rejected:' || coalesce(p_result ->> 'httpStatus', '') || ':' || coalesce(p_result ->> 'code', ''), 200);
    if coalesce((p_result ->> 'retryable')::boolean, false) then
      r.status := case when r.ambiguous then 'unknown' else 'failed' end;
    else
      r.status := case when r.ambiguous then 'needs_reconciliation' else 'rejected' end;
    end if;
  elsif v_kind = 'in_progress' then
    r.ambiguous := true; r.status := 'unknown'; r.last_error := 'provider_in_progress';
  else
    r.ambiguous := true; r.status := 'unknown'; r.last_error := left('outcome_unknown:' || coalesce(p_result ->> 'reason', ''), 200);
  end if;
  if r.status in ('failed', 'unknown') and r.attempts >= p_max_attempts then
    r.status := case when r.ambiguous then 'needs_reconciliation' else 'exhausted' end;
  end if;
  update public.admin_digest_deliveries set
    status = r.status, lease_owner = null, lease_expires_at = null, send_started_at = null,
    ambiguous = r.ambiguous, provider_message_id = r.provider_message_id, last_error = r.last_error, updated_at = v_now
   where occurrence_id = p_occurrence_id and recipient_key = p_recipient_key;
  return 'ok';
end $$;

revoke all on function public.admin_digest_now() from public, anon, authenticated, service_role;
revoke all on function public.admin_digest_delivery_json(public.admin_digest_deliveries) from public, anon, authenticated, service_role;
revoke all on function public.admin_digest_load(text) from public, anon, authenticated;
revoke all on function public.admin_digest_freeze(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.admin_digest_claim(text, text, text, integer, integer, bigint, bigint) from public, anon, authenticated;
revoke all on function public.admin_digest_begin_send(text, text, bigint, integer, bigint, bigint) from public, anon, authenticated;
revoke all on function public.admin_digest_complete(text, text, bigint, jsonb, integer) from public, anon, authenticated;
revoke all on function public.admin_digest_delivery_guard() from public, anon, authenticated, service_role;
revoke all on function public.admin_digest_occurrence_guard() from public, anon, authenticated, service_role;
grant execute on function public.admin_digest_load(text) to service_role;
grant execute on function public.admin_digest_freeze(jsonb, jsonb) to service_role;
grant execute on function public.admin_digest_claim(text, text, text, integer, integer, bigint, bigint) to service_role;
grant execute on function public.admin_digest_begin_send(text, text, bigint, integer, bigint, bigint) to service_role;
grant execute on function public.admin_digest_complete(text, text, bigint, jsonb, integer) to service_role;
