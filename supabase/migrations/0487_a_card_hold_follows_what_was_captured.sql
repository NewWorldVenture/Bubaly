-- 0487: a card hold is released by what was captured.
--
-- Number allocated on #699 (5979394236) for the Support card-hold claim on #771
-- (5979360633), stacked on #925. Filename coordination only: this file is a
-- repository candidate, not an instruction to apply anything to production.
--
-- An approved Issuing authorization holds money: wallet_reserve_card_auth (0155)
-- writes a `processing` card_spend keyed by the authorization id, and every
-- spend decision counts it. Two paths released that hold too early, each able
-- to leave a child's Spend negative:
--
--   1. The first capture released the WHOLE hold (lib/stripe/webhook.ts,
--      releaseCardHold), even when it captured less than was authorized. The
--      part Stripe could still capture became spendable; a later capture of it
--      overdrew.
--   2. issuing_authorization.updated `closed` released the hold before the
--      capture was posted when Stripe sent the close first (it does not order
--      the two). The app half settles the captures the authorization lists
--      before closing; these functions make each step atomic.
--
-- wallet_settle_card_capture posts one capture and draws its authorization's
-- hold down by what it captured, in one transaction under the same spend-bucket
-- row lock wallet_reserve_card_auth takes: the debit, the live hold cancelled,
-- and the uncaptured remainder held again as a fresh `processing` row (rows are
-- never edited beyond the status change 0155 already makes). Done in two app
-- statements instead, a crash between them frees the remainder, and a close
-- running between them leaves the remainder held for ever.
--
-- wallet_close_card_auth releases whatever is left of the hold once Stripe will
-- not capture further (closed / expired / reversed), under the same lock, so it
-- cannot interleave with a capture that is re-holding a remainder.
--
-- Both are idempotent: a capture already settled changes nothing, holds
-- included; a close with nothing live releases nothing. A capture whose debit
-- was posted WITHOUT this function (the lib/wallet/server.ts fallback, while a
-- database lacks it) is settled against its hold the first time it comes
-- through here, and only against holds that existed when it was posted.
--
-- THE REMAINDER IS KEYED `<authorization>#remainder`, not by the authorization
-- id. wallet_reserve_card_auth (0155) answers "already reserved" to ANY live
-- hold keyed by the authorization id, without a balance check. Keyed that way,
-- a remainder would let an incremental authorization after a partial capture
-- through unchecked. Keyed apart, reserve behaves exactly as before this file.
--
-- LOCK ORDER. Each function takes the child wallet FOR KEY SHARE before the
-- spend bucket FOR UPDATE. wallet_credit_child_ledger and wallet_transfer (0205)
-- lock the child wallet FOR UPDATE and then the bucket; a function that locked
-- the bucket first and then inserted a ledger row (whose foreign key needs KEY
-- SHARE on the child wallet) deadlocked against them, reproduced on PostgreSQL
-- 16. KEY SHARE is compatible with 0155's and 0342's own key checks, so the
-- order cannot deadlock against those either.
--
-- Not changed here: wallet_reserve_card_auth, including 0342's note that a
-- request replayed after capture places a fresh hold; partial reversals and
-- incremental authorizations of a still-pending authorization.
--
-- Service-role only, as 0456 requires of every function the webhook calls.
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).

create or replace function public.wallet_settle_card_capture(
  p_family uuid,
  p_child_wallet uuid,
  p_txn_id text,
  p_auth_id text,
  p_amount bigint,
  p_description text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket    uuid;
  v_existing  record;
  v_txn       uuid;
  v_auth      text := nullif(p_auth_id, '');
  v_drawn     bigint;
  v_held      bigint := 0;
  v_hold_ids  uuid[];
  v_remainder bigint := 0;
  v_desc      text := coalesce(nullif(p_description, ''), 'Card purchase');
begin
  if p_txn_id is null or p_txn_id = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_transaction');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  -- Child wallet first (KEY SHARE), then the spend bucket: see LOCK ORDER above.
  perform 1 from public.child_wallets
   where id = p_child_wallet and family_id = p_family
   for key share;
  select id into v_bucket
    from public.wallet_buckets
   where family_id = p_family and child_wallet_id = p_child_wallet and kind = 'spend'
   for update;

  -- Idempotent on the capture, before anything can refuse it: a capture already
  -- posted is a success even if its bucket has since gone.
  select id, amount_cents, created_at, metadata into v_existing
    from public.wallet_transactions
   where stripe_ref = p_txn_id and type = 'card_spend' and status = 'completed'
   order by created_at, id
   limit 1
   for update;
  if found then
    if v_existing.metadata ? 'hold_settled' or v_auth is null or v_bucket is null then
      return jsonb_build_object('ok', true, 'transaction_id', v_existing.id, 'idempotent', true,
                                'released_cents', 0, 'remainder_cents', 0);
    end if;
    -- Posted without this function: settle it against the holds that existed
    -- when it was posted (never one placed after it), once.
    v_drawn := v_existing.amount_cents;
  else
    if v_bucket is null then
      return jsonb_build_object('ok', false, 'reason', 'no_spend_bucket');
    end if;
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref, metadata)
    values
      (p_family, p_child_wallet, v_bucket, 'card_spend', 'completed', 'debit', p_amount, v_desc, p_txn_id,
       jsonb_build_object('source', 'issuing', 'authorization', v_auth, 'hold_settled', v_auth is not null))
    returning id into v_txn;
    v_drawn := p_amount;
  end if;

  if v_auth is not null then
    -- The live hold for this authorization in this child's Spend bucket: the
    -- one its approval placed, and any remainder an earlier capture left.
    with live as (
      update public.wallet_transactions
         set status = 'cancelled',
             metadata = metadata || jsonb_build_object('settled_by', p_txn_id)
       where stripe_ref in (v_auth, v_auth || '#remainder') and type = 'card_spend' and status = 'processing'
         and family_id = p_family and bucket_id = v_bucket
         and (v_existing.created_at is null or created_at <= v_existing.created_at)
      returning id, amount_cents
    )
    select coalesce(sum(amount_cents), 0), array_agg(id) into v_held, v_hold_ids from live;

    -- What this capture did not take stays held, for a later capture or the
    -- authorization's close. A capture of more than was held (a tip) leaves none.
    v_remainder := greatest(v_held - v_drawn, 0);
    if v_remainder > 0 then
      insert into public.wallet_transactions
        (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref, metadata)
      values
        (p_family, p_child_wallet, v_bucket, 'card_spend', 'processing', 'debit', v_remainder, v_desc,
         v_auth || '#remainder',
         jsonb_build_object('source', 'issuing', 'kind', 'hold', 'authorization', v_auth,
                            'remainder_of', to_jsonb(v_hold_ids), 'after_capture', p_txn_id));
    end if;
  end if;

  if v_txn is null then
    -- The fallback-posted debit is settled now; a later delivery must not draw again.
    update public.wallet_transactions
       set metadata = metadata || jsonb_build_object('hold_settled', true, 'authorization', v_auth)
     where id = v_existing.id;
    return jsonb_build_object('ok', true, 'transaction_id', v_existing.id, 'idempotent', true,
                              'released_cents', v_held, 'remainder_cents', v_remainder);
  end if;

  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail, metadata)
  values
    (p_family, null, 'card_spend', 'child_wallets', p_child_wallet,
     v_desc || ' (' || p_amount::text || 'c)'
       || case when v_remainder > 0 then ' — ' || v_remainder::text || 'c still held' else '' end,
     jsonb_build_object('stripeRef', p_txn_id, 'authorization', v_auth, 'remainderCents', v_remainder));

  return jsonb_build_object('ok', true, 'transaction_id', v_txn, 'idempotent', false,
                            'released_cents', v_held, 'remainder_cents', v_remainder);
end $$;

create or replace function public.wallet_close_card_auth(
  p_family uuid,
  p_child_wallet uuid,
  p_auth_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket   uuid;
  v_released bigint := 0;
begin
  if p_auth_id is null or p_auth_id = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_authorization');
  end if;

  -- Same lock order as wallet_settle_card_capture.
  perform 1 from public.child_wallets
   where id = p_child_wallet and family_id = p_family
   for key share;
  select id into v_bucket
    from public.wallet_buckets
   where family_id = p_family and child_wallet_id = p_child_wallet and kind = 'spend'
   for update;
  -- No Spend bucket: no hold of ours can be in one. Nothing to release.
  if v_bucket is null then
    return jsonb_build_object('ok', true, 'released_cents', 0);
  end if;

  with live as (
    update public.wallet_transactions
       set status = 'cancelled'
     where stripe_ref in (p_auth_id, p_auth_id || '#remainder') and type = 'card_spend' and status = 'processing'
       and family_id = p_family and bucket_id = v_bucket
    returning amount_cents
  )
  select coalesce(sum(amount_cents), 0) into v_released from live;

  return jsonb_build_object('ok', true, 'released_cents', v_released);
end $$;

revoke all on function public.wallet_settle_card_capture(uuid, uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.wallet_settle_card_capture(uuid, uuid, text, text, bigint, text) to service_role;
revoke all on function public.wallet_close_card_auth(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.wallet_close_card_auth(uuid, uuid, text) to service_role;

do $check$
declare
  fn text;
begin
  foreach fn in array array[
    'public.wallet_settle_card_capture(uuid, uuid, text, text, bigint, text)',
    'public.wallet_close_card_auth(uuid, uuid, text)'
  ] loop
    if has_function_privilege('anon', fn, 'execute') or has_function_privilege('authenticated', fn, 'execute') then
      raise exception 'a client role can execute %', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception 'service_role cannot execute %, so the webhook cannot', fn;
    end if;
  end loop;
end
$check$;
