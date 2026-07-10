-- ============================================================================
-- 0155 · Card authorization holds (audit PAY-1).
--
-- Real-time card authorization previously approved when amount <= the child's
-- SPEND balance but placed NO hold, so several authorizations landing before any
-- capture posted could each be approved against the same balance → overspend.
--
-- This adds an ATOMIC reserve: under a per-child row lock it re-checks the
-- spendable balance and, if sufficient, writes a `processing` debit ("hold")
-- keyed by the Stripe authorization id. childSpendableCents already counts
-- `processing` debits, so the hold immediately reduces what the next concurrent
-- authorization sees. Holds are released (status → 'cancelled') on capture or on
-- authorization reversal/expiry by the webhook. Immutable-ledger friendly: a hold
-- is a normal txn row whose status transitions processing → completed/cancelled.
--
-- Additive + idempotent. Requires 0088 (wallet) + 0090 (stripe money).
-- Service-role/webhook only; runs as definer so it can serialize on the bucket.
-- ============================================================================

create or replace function public.wallet_reserve_card_auth(
  p_family uuid,
  p_child_wallet uuid,
  p_amount bigint,
  p_auth_id text,
  p_description text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket    uuid;
  v_spendable bigint;
begin
  -- Nothing to reserve → approve (e.g. $0 auth / balance check).
  if p_amount is null or p_amount <= 0 then
    return true;
  end if;

  -- Lock the child's SPEND bucket so concurrent authorizations for the same
  -- child serialize here (each sees the prior hold before deciding).
  select id into v_bucket
    from public.wallet_buckets
   where family_id = p_family and child_wallet_id = p_child_wallet and kind = 'spend'
   for update;
  if v_bucket is null then
    return false;  -- no spend bucket → cannot fund → decline
  end if;

  -- Idempotency: a hold already exists for this authorization (ret, re-delivery).
  if exists (
    select 1 from public.wallet_transactions
     where stripe_ref = p_auth_id and type = 'card_spend' and status = 'processing'
  ) then
    return true;
  end if;

  -- Spendable = completed + processing (holds already reduce this).
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into v_spendable
    from public.wallet_transactions
   where family_id = p_family and bucket_id = v_bucket and status in ('completed', 'processing');

  if p_amount > v_spendable then
    return false;  -- insufficient funds
  end if;

  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref, metadata)
  values
    (p_family, p_child_wallet, v_bucket, 'card_spend', 'processing', 'debit', p_amount,
     coalesce(nullif(p_description, ''), 'Card hold'), p_auth_id,
     jsonb_build_object('source', 'issuing', 'kind', 'hold'));

  return true;
end $$;

revoke all on function public.wallet_reserve_card_auth(uuid, uuid, bigint, text, text) from public;
grant execute on function public.wallet_reserve_card_auth(uuid, uuid, bigint, text, text) to service_role;
