-- Atomic loyalty mutations.
--
-- The loyalty engine is service-role only, but its previous implementation
-- still performed balance, ledger, redemption, and stock writes separately.
-- These functions serialize the affected rows and commit each business
-- operation as one transaction.

create or replace function public.loyalty_award_points(
  p_family_id uuid,
  p_points integer,
  p_kind text default 'earn',
  p_reason text default null,
  p_source text default null,
  p_reward_id uuid default null,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.loyalty_accounts%rowtype;
  v_settings public.loyalty_settings%rowtype;
  v_transaction_id uuid;
  v_new_balance integer;
  v_new_lifetime integer;
  v_silver_at integer;
  v_gold_at integer;
  v_tier text;
begin
  if p_family_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_family');
  end if;
  if p_kind is null or p_kind not in ('earn', 'redeem', 'adjust', 'expire') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_kind');
  end if;

  select * into v_settings
    from public.loyalty_settings
   where singleton = true
   limit 1;
  v_silver_at := greatest(0, coalesce(v_settings.tier_silver_at, 1000));
  v_gold_at := greatest(v_silver_at, coalesce(v_settings.tier_gold_at, 5000));

  -- The unique family_id constraint plus ON CONFLICT makes first-use account
  -- creation safe when two requests arrive for a family simultaneously.
  insert into public.loyalty_accounts (family_id)
  values (p_family_id)
  on conflict (family_id) do nothing;

  select * into v_account
    from public.loyalty_accounts
   where family_id = p_family_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'account_unavailable');
  end if;

  if p_points < 0 and v_account.points_balance + p_points < 0 then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_points');
  end if;

  v_new_balance := v_account.points_balance + p_points;
  v_new_lifetime := v_account.lifetime_points + greatest(0, p_points);
  if v_new_lifetime >= v_gold_at then
    v_tier := 'gold';
  elsif v_new_lifetime >= v_silver_at then
    v_tier := 'silver';
  else
    v_tier := 'bronze';
  end if;

  update public.loyalty_accounts
     set points_balance = v_new_balance,
         lifetime_points = v_new_lifetime,
         tier = v_tier
   where id = v_account.id;

  insert into public.loyalty_transactions
    (family_id, points, kind, reason, source, balance_after, reward_id, created_by)
  values
    (p_family_id, p_points, p_kind, p_reason, p_source, v_new_balance, p_reward_id, p_actor_id)
  returning id into v_transaction_id;

  select * into v_account
    from public.loyalty_accounts
   where id = v_account.id;

  return jsonb_build_object(
    'ok', true,
    'transaction_id', v_transaction_id,
    'account', to_jsonb(v_account)
  );
end;
$$;

create or replace function public.loyalty_redeem_reward(
  p_family_id uuid,
  p_reward_id uuid,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reward public.loyalty_rewards%rowtype;
  v_account public.loyalty_accounts%rowtype;
  v_settings public.loyalty_settings%rowtype;
  v_redemption_id uuid;
  v_transaction_id uuid;
  v_new_balance integer;
  v_silver_at integer;
  v_gold_at integer;
  v_tier text;
begin
  if p_family_id is null or p_reward_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  -- Lock the catalog row before checking finite stock.
  select * into v_reward
    from public.loyalty_rewards
   where id = p_reward_id
     and deleted_at is null
   for update;
  if not found or not v_reward.is_active then
    return jsonb_build_object('ok', false, 'reason', 'not_available');
  end if;
  if v_reward.stock is not null and v_reward.stock <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'out_of_stock');
  end if;

  insert into public.loyalty_accounts (family_id)
  values (p_family_id)
  on conflict (family_id) do nothing;
  select * into v_account
    from public.loyalty_accounts
   where family_id = p_family_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'account_unavailable');
  end if;
  if v_account.points_balance < v_reward.cost_points then
    return jsonb_build_object(
      'ok', false,
      'reason', 'insufficient_points',
      'needed', v_reward.cost_points - v_account.points_balance
    );
  end if;

  select * into v_settings
    from public.loyalty_settings
   where singleton = true
   limit 1;
  v_silver_at := greatest(0, coalesce(v_settings.tier_silver_at, 1000));
  v_gold_at := greatest(v_silver_at, coalesce(v_settings.tier_gold_at, 5000));
  if v_account.lifetime_points >= v_gold_at then
    v_tier := 'gold';
  elsif v_account.lifetime_points >= v_silver_at then
    v_tier := 'silver';
  else
    v_tier := 'bronze';
  end if;

  v_new_balance := v_account.points_balance - v_reward.cost_points;
  update public.loyalty_accounts
     set points_balance = v_new_balance,
         tier = v_tier
   where id = v_account.id;

  insert into public.loyalty_transactions
    (family_id, points, kind, reason, source, balance_after, reward_id, created_by)
  values
    (p_family_id, -v_reward.cost_points, 'redeem', 'Redeemed: ' || v_reward.name,
     'redemption', v_new_balance, v_reward.id, p_actor_id)
  returning id into v_transaction_id;

  insert into public.loyalty_redemptions
    (family_id, reward_id, reward_name, cost_points, status, created_by)
  values
    (p_family_id, v_reward.id, v_reward.name, v_reward.cost_points, 'pending', p_actor_id)
  returning id into v_redemption_id;

  if v_reward.stock is not null then
    update public.loyalty_rewards
       set stock = stock - 1
     where id = v_reward.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'redemption_id', v_redemption_id,
    'transaction_id', v_transaction_id
  );
end;
$$;

create or replace function public.loyalty_cancel_redemption(
  p_redemption_id uuid,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_redemption public.loyalty_redemptions%rowtype;
  v_reward public.loyalty_rewards%rowtype;
  v_account public.loyalty_accounts%rowtype;
  v_transaction_id uuid;
  v_new_balance integer;
begin
  if p_redemption_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select * into v_redemption
    from public.loyalty_redemptions
   where id = p_redemption_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_redemption.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_processed');
  end if;

  -- Return finite stock to the catalog as part of the same transaction.
  if v_redemption.reward_id is not null then
    select * into v_reward
      from public.loyalty_rewards
     where id = v_redemption.reward_id
     for update;
  end if;

  insert into public.loyalty_accounts (family_id)
  values (v_redemption.family_id)
  on conflict (family_id) do nothing;
  select * into v_account
    from public.loyalty_accounts
   where family_id = v_redemption.family_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'account_unavailable');
  end if;

  v_new_balance := v_account.points_balance + greatest(0, v_redemption.cost_points);
  update public.loyalty_accounts
     set points_balance = v_new_balance
   where id = v_account.id;

  if v_redemption.cost_points > 0 then
    insert into public.loyalty_transactions
      (family_id, points, kind, reason, source, balance_after, reward_id, created_by)
    values
      (v_redemption.family_id, v_redemption.cost_points, 'adjust',
       'Redemption cancelled - points refunded', 'redemption_refund',
       v_new_balance, v_redemption.reward_id, p_actor_id)
    returning id into v_transaction_id;
  end if;

  update public.loyalty_redemptions
     set status = 'cancelled'
   where id = v_redemption.id;

  if v_reward.id is not null and v_reward.stock is not null then
    update public.loyalty_rewards
       set stock = stock + 1
     where id = v_reward.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'transaction_id', v_transaction_id,
    'points_refunded', greatest(0, v_redemption.cost_points)
  );
end;
$$;

revoke all on function public.loyalty_award_points(uuid, integer, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.loyalty_award_points(uuid, integer, text, text, text, uuid, uuid) to service_role;
revoke all on function public.loyalty_redeem_reward(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.loyalty_redeem_reward(uuid, uuid, uuid) to service_role;
revoke all on function public.loyalty_cancel_redemption(uuid, uuid) from public, anon, authenticated;
grant execute on function public.loyalty_cancel_redemption(uuid, uuid) to service_role;
