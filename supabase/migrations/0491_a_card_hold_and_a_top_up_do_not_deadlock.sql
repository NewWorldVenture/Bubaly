-- ── A card hold and a top-up do not deadlock (0491) ─────────────────────────
--
-- #771 comment 5982113631; the residual #954 lists as "A deadlock 0155 can
-- hit". Every money function that touches a child's ledger locks two rows of
-- that child: the wallet (`child_wallets`) and a bucket (`wallet_buckets`).
-- 0205's `wallet_credit_child_ledger` and `wallet_transfer` take the wallet
-- FOR UPDATE, then the buckets. These three took a bucket FOR UPDATE first,
-- and the wallet only afterwards, through the foreign key their ledger insert
-- checks (KEY SHARE, which a FOR UPDATE holder blocks):
--
--   wallet_reserve_card_auth (0155)  a card authorization's hold
--   wallet_debit_spend_bucket (0342) a parent's in-app spend
--   invest_decide_order (0447)       a parent approving an investment
--
-- Two orders make a cycle. Against a credit for the same child on
-- PostgreSQL 16 (pgbench, synthetic rows): 73 of 78 reserve/credit and 54 of
-- 63 debit/credit transactions died `deadlock detected`, and an investment
-- approval deadlocked the same way. A reserve that dies is a declined card
-- (`reserveCardAuth` fails closed); a credit that dies is an allowance, a
-- chore reward or a gift that did not land.
--
-- Each now takes KEY SHARE on the wallet before its bucket: the order 0205
-- and #954's 0487 use. KEY SHARE is what the insert takes anyway, two of
-- these still serialize on the bucket as before, and nothing else in the
-- bodies changes — each is restated verbatim from its latest migration with
-- the one lock added. With it, the three and a credit ran 3,894
-- transactions together with no failure.
--
-- `create or replace` keeps each function's owner, grants, comment and
-- SECURITY DEFINER; signatures are unchanged. Probe:
-- docs/audit/a-card-hold-and-a-top-up-do-not-deadlock-check.sql.

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

  -- The child wallet first, then the bucket: the order 0205's credit and
  -- transfer take (0491). KEY SHARE is what this function's ledger insert
  -- takes on the wallet anyway; taken here, before the bucket, a top-up for
  -- the same child can no longer hold the wallet while waiting for this
  -- bucket.
  perform 1 from public.child_wallets
   where id = p_child_wallet and family_id = p_family
   for key share;

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

create or replace function public.wallet_debit_spend_bucket(
  p_family_id uuid,
  p_child_wallet_id uuid,
  p_amount bigint,
  p_type public.wallet_txn_type,
  p_description text,
  p_actor_id uuid,
  p_requires_approval boolean default false,
  p_approved_by uuid default null,
  p_related_type text default null,
  p_related_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_held      boolean := coalesce(p_requires_approval, false);
  v_status    public.wallet_txn_status;
  v_bucket    uuid;
  v_spendable bigint;
  v_existing  uuid;
  v_existing_status public.wallet_txn_status;
  v_txn       uuid;
  v_metadata  jsonb;
  v_description text;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  -- Restates wallet_transactions' own INSERT policy (see the header): a family
  -- manager, acting as themselves. SECURITY DEFINER skips RLS, so this has to
  -- say what RLS would have said.
  if auth.uid() is null
     or p_actor_id is distinct from auth.uid()
     or not public.can_manage_family(p_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  -- The wallet has to be this family's. Without this the family id and the
  -- wallet id are two unrelated parameters and a manager of A could debit B.
  --
  -- FOR KEY SHARE (0491): the wallet before the bucket, the order 0205's
  -- credit and transfer take. Without it the bucket lock below came first and
  -- the ledger insert's foreign key took the wallet second, so a debit and a
  -- top-up for the same child deadlocked.
  perform 1 from public.child_wallets
   where id = p_child_wallet_id and family_id = p_family_id
   for key share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'wallet_not_found');
  end if;

  v_status := case when v_held then 'requires_parent_approval' else 'completed' end;
  v_metadata := case when jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) = 'object'
                     then coalesce(p_metadata, '{}'::jsonb) else '{}'::jsonb end;
  v_description := coalesce(nullif(trim(coalesce(p_description, '')), ''), 'Spend');

  -- THE LOCK. The child's spend bucket is one row and the natural per-child
  -- mutex: every concurrent spender for this child queues here, so the total
  -- below is taken after any debit already in flight, not beside it.
  select id into v_bucket
    from public.wallet_buckets
   where family_id = p_family_id and child_wallet_id = p_child_wallet_id and kind = 'spend'
   for update;
  if v_bucket is null then
    return jsonb_build_object('ok', false, 'reason', 'spend_bucket_missing');
  end if;

  -- Idempotency, in the lock and scoped to this family's bucket. Only when the
  -- caller gave a COMPLETE key; a cancelled or failed predecessor is not a
  -- match, because that debit did not happen.
  if p_related_type is not null and p_related_id is not null then
    select id, status into v_existing, v_existing_status
      from public.wallet_transactions
     where family_id = p_family_id
       and bucket_id = v_bucket
       and related_type = p_related_type
       and related_id = p_related_id
       and direction = 'debit'
       and status in ('requires_parent_approval', 'processing', 'completed')
     order by created_at
     limit 1;
    if found then
      return jsonb_build_object(
        'ok', true, 'transaction_id', v_existing, 'status', v_existing_status, 'idempotent', true);
    end if;
  end if;

  -- The total, INSIDE the lock, over money that is committed or held. 0155
  -- counts the same two statuses, so a live card hold and an in-app spend can no
  -- longer each be approved against the same dollar.
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into v_spendable
    from public.wallet_transactions
   where family_id = p_family_id
     and bucket_id = v_bucket
     and status in ('completed', 'processing');

  -- A held debit moves nothing and is re-checked by wallet_decide_spend under
  -- this same lock before it posts, so it is admitted; a debit that posts NOW
  -- has to fit now.
  if not v_held and p_amount > v_spendable then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'available', v_spendable);
  end if;

  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
     description, related_type, related_id, created_by, approved_by, metadata)
  values
    (p_family_id, p_child_wallet_id, v_bucket, p_type, v_status, 'debit', p_amount,
     v_description, p_related_type, p_related_id, p_actor_id,
     case when v_held then null else coalesce(p_approved_by, p_actor_id) end,
     v_metadata)
  returning id into v_txn;

  -- In the same transaction as the debit, so money cannot move without a trail.
  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail)
  values
    (p_family_id, p_actor_id, 'debit_' || p_type::text, 'child_wallets', p_child_wallet_id,
     v_description || ' (' || p_amount::text || 'c)'
       || case when v_held then ' — pending approval' else '' end);

  return jsonb_build_object(
    'ok', true,
    'transaction_id', v_txn,
    'status', v_status,
    'available', v_spendable,
    'idempotent', false);
end;
$$;

create or replace function public.invest_decide_order(
  p_order_id uuid,
  p_approve boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_bucket uuid;
  v_balance bigint;
  v_txn_id uuid;
  v_holding_id uuid;
  v_existing_shares numeric;
  v_existing_avg bigint;
  v_has_holding boolean := false;
  v_new_shares numeric;
  v_new_avg bigint;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  select id, family_id, child_wallet_id, asset_id, side, shares, price_cents,
         amount_cents, status
    into v_order
    from public.invest_orders
   where id = p_order_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not public.can_manage_family(v_order.family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_order.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided');
  end if;

  if not p_approve then
    update public.invest_orders
       set status = 'rejected', decided_by = auth.uid(), decided_at = now()
     where id = v_order.id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  -- The child wallet first, then the bucket: the order 0205's credit and
  -- transfer take (0491). The ledger and holdings inserts below take KEY
  -- SHARE on the wallet anyway; taken after the bucket, an approval and a
  -- top-up for the same child deadlocked.
  perform 1 from public.child_wallets
   where id = v_order.child_wallet_id and family_id = v_order.family_id
   for key share;

  select id into v_bucket
    from public.wallet_buckets
   where family_id = v_order.family_id
     and child_wallet_id = v_order.child_wallet_id
     and kind = 'invest'
   for update;
  if v_bucket is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_invest_bucket');
  end if;

  -- Serialize against concurrent wallet movements for this investment bucket.
  perform 1
    from public.wallet_transactions
   where family_id = v_order.family_id
     and bucket_id = v_bucket
     and status in ('completed', 'processing')
   for update;
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)::bigint
    into v_balance
    from public.wallet_transactions
   where family_id = v_order.family_id
     and bucket_id = v_bucket
     and status in ('completed', 'processing');

  select id, shares, avg_cost_cents
    into v_holding_id, v_existing_shares, v_existing_avg
    from public.invest_holdings
   where family_id = v_order.family_id
     and child_wallet_id = v_order.child_wallet_id
     and asset_id = v_order.asset_id
   for update;
  v_has_holding := found;

  if v_order.side = 'buy' then
    if v_order.amount_cents > v_balance then
      return jsonb_build_object('ok', false, 'reason', 'insufficient_cash');
    end if;
    v_new_shares := coalesce(v_existing_shares, 0) + v_order.shares;
    v_new_avg := round((coalesce(v_existing_shares, 0) * coalesce(v_existing_avg, 0)
      + v_order.shares * v_order.price_cents) / nullif(v_new_shares, 0));
  elsif not v_has_holding or v_existing_shares < v_order.shares then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_shares');
  end if;

  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction,
     amount_cents, description, related_type, related_id, created_by, approved_by,
     metadata)
  values
    (v_order.family_id, v_order.child_wallet_id, v_bucket, 'adjustment', 'completed',
     -- The cast is the fix (0447). A CASE over two literals is `text`, not
     -- `unknown`, and `text` does not implicitly cast to an enum.
     (case when v_order.side = 'buy' then 'debit' else 'credit' end)::public.wallet_txn_direction,
     v_order.amount_cents,
     case when v_order.side = 'buy' then 'Invest: bought shares' else 'Invest: sold shares' end,
     'invest_orders', v_order.id, auth.uid(), auth.uid(),
     jsonb_build_object('side', v_order.side, 'shares', v_order.shares))
  returning id into v_txn_id;

  if v_order.side = 'buy' then
    if v_has_holding then
      update public.invest_holdings
         set shares = v_new_shares, avg_cost_cents = v_new_avg
       where id = v_holding_id;
    else
      insert into public.invest_holdings
        (family_id, child_wallet_id, asset_id, shares, avg_cost_cents)
      values
        (v_order.family_id, v_order.child_wallet_id, v_order.asset_id,
         v_order.shares, v_order.price_cents);
    end if;
  else
    update public.invest_holdings
       set shares = greatest(0, v_existing_shares - v_order.shares)
     where id = v_holding_id;
  end if;

  update public.invest_orders
     set status = 'filled', txn_id = v_txn_id, decided_by = auth.uid(), decided_at = now()
   where id = v_order.id;
  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail)
  values
    (v_order.family_id, auth.uid(), 'invest_' || v_order.side, 'invest_orders',
     v_order.id, v_order.side || ' ' || v_order.shares || ' shares');

  return jsonb_build_object('ok', true, 'status', 'filled', 'txn_id', v_txn_id);
end;
$$;
