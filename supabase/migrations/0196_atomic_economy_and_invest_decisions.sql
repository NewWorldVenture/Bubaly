-- FamilyOS :: 0196 - atomic economy redemption and simulated-investment fills
--
-- Approval previously performed a ledger insert followed by separate status,
-- holding, stock, and audit writes from the application. A later failure could
-- leave a debit without a fulfilled redemption or cash movement without the
-- corresponding holding/order state. These authenticated RPCs serialize the
-- relevant rows and commit the complete decision as one transaction.

create or replace function public.economy_decide_redemption(
  p_redemption_id uuid,
  p_approve boolean,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_redemption record;
  v_reward record;
  v_has_reward boolean := false;
  v_balance bigint;
  v_txn_id uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  select id, family_id, reward_id, currency_id, member_id, cost, status
    into v_redemption
    from public.economy_redemptions
   where id = p_redemption_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not public.can_manage_family(v_redemption.family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_redemption.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided');
  end if;

  if not p_approve then
    update public.economy_redemptions
       set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
           note = left(nullif(trim(coalesce(p_note, '')), ''), 1000)
     where id = v_redemption.id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  if v_redemption.reward_id is not null then
    select id, stock into v_reward
      from public.economy_rewards
     where id = v_redemption.reward_id
       and family_id = v_redemption.family_id
     for update;
    v_has_reward := found;
    if v_has_reward and v_reward.stock is not null and v_reward.stock <= 0 then
      return jsonb_build_object('ok', false, 'reason', 'out_of_stock');
    end if;
  end if;

  -- Lock the member's ledger rows before checking the balance. This makes two
  -- concurrent approvals observe each other's debit instead of overspending.
  perform 1
    from public.currency_transactions
   where family_id = v_redemption.family_id
     and currency_id = v_redemption.currency_id
     and member_id = v_redemption.member_id
   for update;
  select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::bigint
    into v_balance
    from public.currency_transactions
   where family_id = v_redemption.family_id
     and currency_id = v_redemption.currency_id
     and member_id = v_redemption.member_id;
  if v_balance < v_redemption.cost then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_tokens');
  end if;

  insert into public.currency_transactions
    (family_id, currency_id, member_id, direction, amount, reason,
     related_type, related_id, created_by)
  values
    (v_redemption.family_id, v_redemption.currency_id, v_redemption.member_id,
     'debit', v_redemption.cost, 'Reward redeemed', 'redemption',
     v_redemption.id, auth.uid())
  returning id into v_txn_id;

  update public.economy_redemptions
     set status = 'fulfilled', txn_id = v_txn_id, decided_by = auth.uid(),
         decided_at = now(), note = left(nullif(trim(coalesce(p_note, '')), ''), 1000)
   where id = v_redemption.id;

  if v_has_reward and v_reward.stock is not null then
    update public.economy_rewards
       set stock = stock - 1
     where id = v_reward.id and stock > 0;
  end if;

  return jsonb_build_object('ok', true, 'status', 'fulfilled', 'txn_id', v_txn_id);
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
     case when v_order.side = 'buy' then 'debit' else 'credit' end,
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

revoke all on function public.economy_decide_redemption(uuid, boolean, text) from public;
grant execute on function public.economy_decide_redemption(uuid, boolean, text) to authenticated;
revoke all on function public.invest_decide_order(uuid, boolean) from public;
grant execute on function public.invest_decide_order(uuid, boolean) to authenticated;
