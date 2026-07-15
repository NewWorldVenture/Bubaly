-- Keep goal funding's wallet debit, goal progress, and audit event atomic.
-- The Save balance is rechecked while its bucket is locked so concurrent
-- funding attempts cannot overspend the same child wallet.

create or replace function public.wallet_fund_goal(
  p_family_id uuid,
  p_goal_id uuid,
  p_amount bigint,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_goal public.wallet_goals%rowtype;
  v_child_id uuid;
  v_save_bucket_id uuid;
  v_available bigint;
  v_saved bigint;
  v_transaction_id uuid;
begin
  if auth.uid() is null or p_actor_id is distinct from auth.uid()
     or not public.can_manage_family(p_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  select * into v_goal
    from public.wallet_goals
   where id = p_goal_id and family_id = p_family_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'goal_not_found');
  end if;
  if v_goal.child_wallet_id is null then
    return jsonb_build_object('ok', false, 'reason', 'goal_wallet_required');
  end if;

  select id into v_child_id
    from public.child_wallets
   where id = v_goal.child_wallet_id
     and family_id = p_family_id
     and is_active
   for update;
  if v_child_id is null then
    return jsonb_build_object('ok', false, 'reason', 'wallet_not_found');
  end if;

  select id into v_save_bucket_id
    from public.wallet_buckets
   where family_id = p_family_id
     and child_wallet_id = v_child_id
     and kind = 'save'
   for update;
  if v_save_bucket_id is null then
    return jsonb_build_object('ok', false, 'reason', 'save_bucket_missing');
  end if;

  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into v_available
    from public.wallet_transactions
   where family_id = p_family_id
     and bucket_id = v_save_bucket_id
     and status = 'completed';
  if p_amount > v_available then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'available', v_available);
  end if;

  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
     description, related_type, related_id, created_by, approved_by)
  values
    (p_family_id, v_child_id, v_save_bucket_id, 'goal_transfer', 'completed', 'debit', p_amount,
     left('Into goal: ' || v_goal.title, 500), 'wallet_goals', v_goal.id, p_actor_id, p_actor_id)
  returning id into v_transaction_id;

  v_saved := v_goal.saved_cents + p_amount;
  update public.wallet_goals
     set saved_cents = v_saved,
         status = case when v_saved >= v_goal.target_cents then 'reached' else v_goal.status end
   where id = v_goal.id;

  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail, metadata)
  values
    (p_family_id, p_actor_id, 'goal_funded', 'wallet_goals', v_goal.id,
     left('Funded ' || p_amount || 'c into ' || v_goal.title, 500),
     jsonb_build_object('transaction_id', v_transaction_id, 'amount_cents', p_amount));

  return jsonb_build_object(
    'ok', true,
    'transaction_id', v_transaction_id,
    'saved_cents', v_saved
  );
end;
$$;

revoke all on function public.wallet_fund_goal(uuid, uuid, bigint, uuid) from public, anon;
grant execute on function public.wallet_fund_goal(uuid, uuid, bigint, uuid) to authenticated;
