-- 0474: an admin removed after a digest was frozen is not sent it. (API-96040DFB5635, JOB-EF2453D9F633)
--
-- Number reserved by the coordinator on #710 for this bounded extension of 0471.
-- 0471 is not rewritten: this migration only extends it.
--
-- Eligibility is the code/config allowlist UNION public.super_admins. It is
-- decided at DISPATCH ADMISSION, inside admin_digest_begin_send, for a first
-- send, a retry and a resume alike:
--   - the caller passes p_allowlisted (the code/config half, which only the
--     application can see);
--   - the function reads public.super_admins itself, AFTER the row lock, so a
--     removal committed before the admission is always seen. A table address
--     matches on trim plus ASCII-only lowercasing, independent of collation; one
--     that differs from the recipient only in non-ASCII case does not match;
--   - a recipient in neither is WITHDRAWN: the row becomes the terminal status
--     'withdrawn' under the current fence, and nothing is dispatched. Its
--     bytes, key, attempts, retention anchor and ambiguity are kept, so an
--     earlier send that may have been accepted is never relabelled as
--     "never delivered". A stale claimant is fenced out, and no later claim
--     can take the row;
--   - an unreadable super_admins fails closed: the call errors and writes nothing.
-- The ordering boundary: a removal committed after an admission was granted
-- cannot stop that one dispatch. The dispatch must still start before the
-- grant's dispatchBy (the lease minus the send deadline). Every later
-- admission is refused.

-- ── a terminal 'withdrawn' status ────────────────────────────────────────────
alter table public.admin_digest_deliveries drop constraint admin_digest_deliveries_status_check;
alter table public.admin_digest_deliveries add constraint admin_digest_deliveries_status_check
  check (status in ('pending', 'in_flight', 'failed', 'unknown', 'accepted', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation', 'withdrawn'));

-- ── the guard: a withdrawn row stays withdrawn, like every settled row ───────
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
  if old.status in ('accepted', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation', 'withdrawn') and new.status is distinct from old.status then
    raise exception 'a settled admin digest delivery (%) stays settled', old.status using errcode = '42501';
  end if;
  if new.attempts < old.attempts or new.fence < old.fence or (old.ambiguous and not new.ambiguous)
     or (old.first_send_at is not null and new.first_send_at is distinct from old.first_send_at) then
    raise exception 'attempts, fence, ambiguity and the retention anchor only move forward' using errcode = '42501';
  end if;
  return new;
end $$;

-- ── claim: a withdrawn row is never claimed again ───────────────────────────
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
  if r.status in ('accepted', 'rejected', 'conflict', 'exhausted', 'needs_reconciliation', 'withdrawn') then
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

-- ── beginSend: eligibility decided at admission, after the row lock ──────────
-- The six-argument 0471 version is dropped, so nothing can reach a dispatch without the check.
drop function if exists public.admin_digest_begin_send(text, text, bigint, integer, bigint, bigint);
create or replace function public.admin_digest_begin_send(
  p_occurrence_id text, p_recipient_key text, p_fence bigint,
  p_min_lease_ms integer, p_retention_ms bigint, p_margin_ms bigint, p_allowlisted boolean
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  r         public.admin_digest_deliveries%rowtype;
  v_now     timestamptz;
  v_listed  boolean;
begin
  if p_min_lease_ms is null or p_min_lease_ms < 0 or p_retention_ms is null or p_margin_ms is null
     or p_margin_ms < 1 or p_margin_ms >= p_retention_ms or p_retention_ms > 86400000 then
    raise exception 'admin_digest_begin_send: bad lease or retention' using errcode = '22023';
  end if;
  if p_fence is null then
    raise exception 'admin_digest_begin_send: a fence is required' using errcode = '22023';
  end if;
  if p_allowlisted is null then
    raise exception 'admin_digest_begin_send: allowlist membership is required' using errcode = '22023';
  end if;
  select * into r from public.admin_digest_deliveries
   where occurrence_id = p_occurrence_id and recipient_key = p_recipient_key
   for update;
  -- is distinct from: a NULL can never read as a match, even without the guard above.
  if not found or r.status <> 'in_flight' or r.fence is distinct from p_fence then
    return jsonb_build_object('answer', 'fenced_out');
  end if;
  v_now := public.admin_digest_now();
  -- Eligibility, read after the lock: the allowlist half from the caller, super_admins from here.
  -- The table is read on every admission, allowlisted or not, so an unreadable table always fails
  -- the call.
  -- A table address matches the frozen recipient only if, trimmed of what JavaScript's
  -- String.prototype.trim removes and with ASCII A-Z lowercased, its hash is the recipient key (the
  -- engine's trim().toLowerCase() identity). Only ASCII is lowercased, on purpose: lower() follows
  -- the database collation (libc C.UTF-8 and ICU tr-TR turn U+0130 into a plain "i"), so it could
  -- let one table row stand in for a different, removed admin. With ASCII-only folding a match
  -- implies the engine's identity matches; an address that differs only in non-ASCII case cannot
  -- be proved equal, does not match, and is withdrawn: the safe side.
  -- (lib/admin/digest-delivery.ts superAdminTableKey is this rule in TypeScript.)
  v_listed := exists (
    select 1 from public.super_admins s
     where encode(sha256(convert_to(translate(regexp_replace(s.email,
             '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
             '', 'g'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'UTF8')), 'hex') = r.recipient_key);
  if not (p_allowlisted or v_listed) then
    update public.admin_digest_deliveries set
      status = 'withdrawn', lease_owner = null, lease_expires_at = null, send_started_at = null,
      last_error = 'recipient_no_longer_eligible', updated_at = v_now
     where occurrence_id = p_occurrence_id and recipient_key = p_recipient_key;
    return jsonb_build_object('answer', 'withdrawn');
  end if;
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

revoke all on function public.admin_digest_delivery_guard() from public, anon, authenticated, service_role;
revoke all on function public.admin_digest_claim(text, text, text, integer, integer, bigint, bigint) from public, anon, authenticated;
revoke all on function public.admin_digest_begin_send(text, text, bigint, integer, bigint, bigint, boolean) from public, anon, authenticated;
grant execute on function public.admin_digest_claim(text, text, text, integer, integer, bigint, bigint) to service_role;
grant execute on function public.admin_digest_begin_send(text, text, bigint, integer, bigint, bigint, boolean) to service_role;
