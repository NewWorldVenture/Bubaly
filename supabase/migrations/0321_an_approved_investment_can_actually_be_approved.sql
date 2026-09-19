-- Bubaly :: 0321 - a parent could reject an investment order and never approve one
--
-- `invest_decide_order` has two outcomes and only one of them has ever worked.
-- Measured, as a manager, against a funded wallet and a pending buy order:
--
--   invest_decide_order(APPROVE) FAILS: column "direction" is of type
--                                wallet_txn_direction but expression is of
--                                type text (42804)
--   invest_decide_order(REJECT)  -> {"ok": true, "status": "rejected"}
--
-- The ledger insert on the approval path writes `direction` from a CASE:
--
--   case when v_order.side = 'buy' then 'debit' else 'credit' end,
--
-- A bare string literal is of type `unknown` and Postgres happily coerces it to
-- the target enum — which is why `'adjustment'` and `'completed'` on the two
-- lines above it are fine. A CASE over two such literals is NOT unknown: the
-- expression resolves to `text`, and there is no implicit cast from `text` to
-- an enum. Demonstrated on the real type:
--
--   insert into t(direction) values ('debit');                             -- OK
--   insert into t(direction) values (case when true then 'debit'
--                                         else 'credit' end);              -- 42804
--
-- So `type` and `status` on adjacent lines of the same INSERT are correct and
-- `direction` is not, which is the whole reason this survived review: the line
-- reads exactly like its neighbours.
--
-- The asymmetry is what made it invisible in use. The reject path returns
-- before this INSERT, so it works; a parent can decline a child's investment
-- for ever and the feature looks alive. Only approval throws, and it has thrown
-- since 0196 created the function — the definition was never replaced, so no
-- child has ever had a buy or sell order filled.
--
-- Nothing else in the function changes. The cast is added and the rest is
-- 0196's text verbatim, so this migration is reviewable as a one-line diff.
--
-- Found by `plpgsql_check`, which resolves a plpgsql body against the real
-- catalogue instead of waiting for the line to be reached. A plpgsql function
-- binds its SQL at CALL time, so a body can be catastrophically wrong and still
-- install cleanly — the same property that hid 0318's unreachable
-- `gen_random_bytes` behind a membership check. It reported exactly one error
-- across every non-trigger plpgsql function in `public`, and this was it.

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
     -- The cast is the fix (0321). A CASE over two literals is `text`, not
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

revoke all on function public.invest_decide_order(uuid, boolean) from public;
grant execute on function public.invest_decide_order(uuid, boolean) to authenticated;

comment on function public.invest_decide_order(uuid, boolean) is
  'Decides a child investment order. The wallet direction is cast explicitly to wallet_txn_direction: a CASE over two string literals is text, not unknown, so it does not implicitly cast to the enum and every APPROVAL raised 42804 from 0196 until 0321 while rejection worked (0321).';
