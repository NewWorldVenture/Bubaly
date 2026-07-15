-- Atomic Wallet money actions.
--
-- The Wallet ledger is immutable, but several authenticated actions previously
-- wrote the ledger and its approval/gift state in separate requests. These
-- functions serialize the affected rows and commit the complete operation as
-- one transaction.

-- Internal helper. It is callable by the public Wallet RPCs only; it is not
-- granted to application roles directly.
create or replace function public.wallet_credit_child_ledger(
  p_family_id uuid,
  p_child_wallet_id uuid,
  p_amount bigint,
  p_type public.wallet_txn_type,
  p_description text,
  p_created_by uuid,
  p_related_type text default null,
  p_related_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_child_id uuid;
  v_split jsonb;
  v_spend_pct numeric;
  v_save_pct numeric;
  v_give_pct numeric;
  v_invest_pct numeric;
  v_total_pct numeric;
  v_spend_cents bigint;
  v_save_cents bigint;
  v_give_cents bigint;
  v_invest_cents bigint;
  v_remainder bigint;
  v_inserted_id uuid;
  v_first_id uuid;
  v_split_json jsonb;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  select id into v_child_id
    from public.child_wallets
   where id = p_child_wallet_id
     and family_id = p_family_id
     and is_active
   for update;
  if v_child_id is null then
    return jsonb_build_object('ok', false, 'reason', 'wallet_not_found');
  end if;

  -- Lock all recipient buckets in a stable order before deriving the split.
  perform id
    from public.wallet_buckets
   where family_id = p_family_id
     and child_wallet_id = p_child_wallet_id
     and kind in ('spend', 'save', 'give', 'invest')
   order by kind
   for update;

  if (select count(*) from public.wallet_buckets
       where family_id = p_family_id and child_wallet_id = p_child_wallet_id
         and kind in ('spend', 'save', 'give', 'invest')) <> 4 then
    return jsonb_build_object('ok', false, 'reason', 'wallet_buckets_missing');
  end if;

  select split into v_split
    from public.wallet_rules
   where family_id = p_family_id
     and child_wallet_id = p_child_wallet_id
   limit 1;
  v_split := coalesce(v_split, '{}'::jsonb);

  v_spend_pct := case when jsonb_typeof(v_split->'spend') = 'number' then (v_split->>'spend')::numeric else 40 end;
  v_save_pct := case when jsonb_typeof(v_split->'save') = 'number' then (v_split->>'save')::numeric else 40 end;
  v_give_pct := case when jsonb_typeof(v_split->'give') = 'number' then (v_split->>'give')::numeric else 10 end;
  v_invest_pct := case when jsonb_typeof(v_split->'invest') = 'number' then (v_split->>'invest')::numeric else 10 end;
  v_spend_pct := greatest(0, v_spend_pct);
  v_save_pct := greatest(0, v_save_pct);
  v_give_pct := greatest(0, v_give_pct);
  v_invest_pct := greatest(0, v_invest_pct);
  v_total_pct := v_spend_pct + v_save_pct + v_give_pct + v_invest_pct;
  if v_total_pct <> 100 then
    v_spend_pct := 40;
    v_save_pct := 40;
    v_give_pct := 10;
    v_invest_pct := 10;
  end if;

  -- Match lib/wallet/ledger.ts: floor each share, then distribute remainder
  -- in save, spend, give, invest order without creating or destroying cents.
  v_spend_cents := floor((p_amount::numeric * v_spend_pct) / 100)::bigint;
  v_save_cents := floor((p_amount::numeric * v_save_pct) / 100)::bigint;
  v_give_cents := floor((p_amount::numeric * v_give_pct) / 100)::bigint;
  v_invest_cents := floor((p_amount::numeric * v_invest_pct) / 100)::bigint;
  v_remainder := p_amount - v_spend_cents - v_save_cents - v_give_cents - v_invest_cents;

  while v_remainder > 0 loop
    if v_save_pct > 0 then
      v_save_cents := v_save_cents + 1;
    end if;
    v_remainder := v_remainder - case when v_save_pct > 0 then 1 else 0 end;
    exit when v_remainder <= 0;
    if v_spend_pct > 0 then
      v_spend_cents := v_spend_cents + 1;
    end if;
    v_remainder := v_remainder - case when v_spend_pct > 0 then 1 else 0 end;
    exit when v_remainder <= 0;
    if v_give_pct > 0 then
      v_give_cents := v_give_cents + 1;
    end if;
    v_remainder := v_remainder - case when v_give_pct > 0 then 1 else 0 end;
    exit when v_remainder <= 0;
    if v_invest_pct > 0 then
      v_invest_cents := v_invest_cents + 1;
    end if;
    v_remainder := v_remainder - case when v_invest_pct > 0 then 1 else 0 end;
  end loop;

  v_split_json := jsonb_build_object(
    'spend', v_spend_pct, 'save', v_save_pct, 'give', v_give_pct, 'invest', v_invest_pct
  );

  if v_spend_cents > 0 then
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
       description, related_type, related_id, created_by, approved_by, metadata)
    select p_family_id, p_child_wallet_id, id, p_type, 'completed', 'credit', v_spend_cents,
           left(coalesce(p_description, 'Wallet credit'), 500), p_related_type, p_related_id,
           p_created_by, p_created_by, jsonb_build_object('split', v_split_json)
      from public.wallet_buckets
     where id = (select id from public.wallet_buckets where family_id = p_family_id and child_wallet_id = p_child_wallet_id and kind = 'spend')
    returning id into v_inserted_id;
    v_first_id := coalesce(v_first_id, v_inserted_id);
  end if;
  if v_save_cents > 0 then
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
       description, related_type, related_id, created_by, approved_by, metadata)
    select p_family_id, p_child_wallet_id, id, p_type, 'completed', 'credit', v_save_cents,
           left(coalesce(p_description, 'Wallet credit'), 500), p_related_type, p_related_id,
           p_created_by, p_created_by, jsonb_build_object('split', v_split_json)
      from public.wallet_buckets
     where family_id = p_family_id and child_wallet_id = p_child_wallet_id and kind = 'save'
    returning id into v_inserted_id;
    v_first_id := coalesce(v_first_id, v_inserted_id);
  end if;
  if v_give_cents > 0 then
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
       description, related_type, related_id, created_by, approved_by, metadata)
    select p_family_id, p_child_wallet_id, id, p_type, 'completed', 'credit', v_give_cents,
           left(coalesce(p_description, 'Wallet credit'), 500), p_related_type, p_related_id,
           p_created_by, p_created_by, jsonb_build_object('split', v_split_json)
      from public.wallet_buckets
     where family_id = p_family_id and child_wallet_id = p_child_wallet_id and kind = 'give'
    returning id into v_inserted_id;
    v_first_id := coalesce(v_first_id, v_inserted_id);
  end if;
  if v_invest_cents > 0 then
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
       description, related_type, related_id, created_by, approved_by, metadata)
    select p_family_id, p_child_wallet_id, id, p_type, 'completed', 'credit', v_invest_cents,
           left(coalesce(p_description, 'Wallet credit'), 500), p_related_type, p_related_id,
           p_created_by, p_created_by, jsonb_build_object('split', v_split_json)
      from public.wallet_buckets
     where family_id = p_family_id and child_wallet_id = p_child_wallet_id and kind = 'invest'
    returning id into v_inserted_id;
    v_first_id := coalesce(v_first_id, v_inserted_id);
  end if;

  return jsonb_build_object('ok', true, 'transaction_id', v_first_id, 'credited', p_amount);
end;
$$;

create or replace function public.wallet_transfer(
  p_family_id uuid,
  p_from_child_wallet_id uuid,
  p_to_child_wallet_id uuid,
  p_amount bigint,
  p_note text default null,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet_count integer;
  v_from_bucket uuid;
  v_available bigint;
  v_debit_id uuid;
  v_credit jsonb;
  v_note text := left(coalesce(nullif(trim(p_note), ''), 'Transfer'), 500);
begin
  if auth.uid() is null or p_actor_id is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if not public.can_manage_family(p_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_from_child_wallet_id = p_to_child_wallet_id or p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select count(*) into v_wallet_count
    from public.child_wallets
   where family_id = p_family_id
     and is_active
     and id in (p_from_child_wallet_id, p_to_child_wallet_id);
  if v_wallet_count <> 2 then
    return jsonb_build_object('ok', false, 'reason', 'wallet_not_found');
  end if;
  perform id from public.child_wallets
   where family_id = p_family_id and is_active and id in (p_from_child_wallet_id, p_to_child_wallet_id)
   order by id for update;

  select id into v_from_bucket
    from public.wallet_buckets
   where family_id = p_family_id and child_wallet_id = p_from_child_wallet_id and kind = 'spend'
   for update;
  if v_from_bucket is null then
    return jsonb_build_object('ok', false, 'reason', 'spend_bucket_missing');
  end if;

  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into v_available
    from public.wallet_transactions
   where family_id = p_family_id and bucket_id = v_from_bucket and status = 'completed';
  if p_amount > v_available then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'available', v_available);
  end if;

  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
     description, related_type, related_id, created_by, approved_by, metadata)
  values
    (p_family_id, p_from_child_wallet_id, v_from_bucket, 'transfer', 'completed', 'debit', p_amount,
     'Sent: ' || v_note, 'child_wallets', p_to_child_wallet_id, p_actor_id, p_actor_id,
     jsonb_build_object('note', v_note))
  returning id into v_debit_id;

  v_credit := public.wallet_credit_child_ledger(
    p_family_id, p_to_child_wallet_id, p_amount, 'transfer', 'Received: ' || v_note,
    p_actor_id, 'child_wallets', p_from_child_wallet_id
  );
  if coalesce((v_credit->>'ok')::boolean, false) is not true then
    raise exception 'wallet transfer credit failed: %', coalesce(v_credit->>'reason', 'unknown');
  end if;

  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail, metadata)
  values
    (p_family_id, p_actor_id, 'wallet_transfer', 'wallet_transactions', v_debit_id,
     left('Transferred ' || p_amount || ' cents', 500), jsonb_build_object('to_child_wallet_id', p_to_child_wallet_id));

  return jsonb_build_object('ok', true, 'debit_transaction_id', v_debit_id,
    'credit_transaction_id', v_credit->>'transaction_id');
end;
$$;

create or replace function public.wallet_approve_gift(
  p_family_id uuid,
  p_gift_payment_id uuid,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_gift public.gift_payments%rowtype;
  v_credit jsonb;
begin
  if auth.uid() is null or p_actor_id is distinct from auth.uid() or not public.can_manage_family(p_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  select * into v_gift from public.gift_payments
   where id = p_gift_payment_id and family_id = p_family_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_gift.status <> 'pending' or v_gift.applied_txn_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_processed');
  end if;
  if v_gift.child_wallet_id is null or v_gift.amount_cents <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_gift');
  end if;

  v_credit := public.wallet_credit_child_ledger(
    p_family_id, v_gift.child_wallet_id, v_gift.amount_cents, 'gift_received',
    left(coalesce('Gift received' || case when v_gift.giver_name is null then '' else ' from ' || v_gift.giver_name end, 'Gift received'), 500),
    p_actor_id, 'gift_payments', v_gift.id
  );
  if coalesce((v_credit->>'ok')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', coalesce(v_credit->>'reason', 'credit_failed'));
  end if;

  update public.gift_payments
     set status = 'completed', applied_txn_id = (v_credit->>'transaction_id')::uuid
   where id = v_gift.id;
  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail)
  values (p_family_id, p_actor_id, 'gift_approved', 'gift_payments', v_gift.id, 'Gift credited to child wallet');
  return jsonb_build_object('ok', true, 'transaction_id', v_credit->>'transaction_id');
end;
$$;

create or replace function public.wallet_decide_spend(
  p_family_id uuid,
  p_approval_id uuid,
  p_decision text,
  p_note text default null,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_approval public.parent_approvals%rowtype;
  v_txn public.wallet_transactions%rowtype;
  v_available bigint;
  v_bucket uuid;
begin
  if auth.uid() is null or p_actor_id is distinct from auth.uid() or not public.can_manage_family(p_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_decision not in ('approved', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'invalid_decision'); end if;
  select * into v_approval from public.parent_approvals
   where id = p_approval_id and family_id = p_family_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_approval.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_processed'); end if;
  if v_approval.kind <> 'card_spend' or v_approval.ref_type <> 'wallet_transactions' or v_approval.ref_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_approval');
  end if;
  select * into v_txn from public.wallet_transactions where id = v_approval.ref_id and family_id = p_family_id for update;
  if not found or v_txn.status <> 'requires_parent_approval' then return jsonb_build_object('ok', false, 'reason', 'transaction_unavailable'); end if;

  if p_decision = 'approved' then
    select id into v_bucket from public.wallet_buckets
     where id = v_txn.bucket_id and family_id = p_family_id and child_wallet_id = v_txn.child_wallet_id and kind = 'spend' for update;
    if v_bucket is null then return jsonb_build_object('ok', false, 'reason', 'spend_bucket_missing'); end if;
    select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
      into v_available from public.wallet_transactions
     where family_id = p_family_id and bucket_id = v_bucket and status = 'completed';
    if v_txn.amount_cents > v_available then return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'available', v_available); end if;
    update public.wallet_transactions set status = 'completed', approved_by = p_actor_id where id = v_txn.id;
  else
    update public.wallet_transactions set status = 'cancelled' where id = v_txn.id;
  end if;

  update public.parent_approvals
     set status = p_decision::public.approval_status, decided_by = p_actor_id,
         decided_at = now(), note = left(nullif(trim(coalesce(p_note, '')), ''), 1000)
   where id = v_approval.id;
  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail)
  values (p_family_id, p_actor_id, 'spend_' || p_decision, 'wallet_transactions', v_txn.id,
    'Spend request ' || p_decision);
  return jsonb_build_object('ok', true, 'decision', p_decision, 'transaction_id', v_txn.id);
end;
$$;

create or replace function public.wallet_decide_allowance(
  p_family_id uuid,
  p_approval_id uuid,
  p_decision text,
  p_note text default null,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_approval public.parent_approvals%rowtype;
  v_credit jsonb;
  v_description text;
begin
  if auth.uid() is null or p_actor_id is distinct from auth.uid() or not public.can_manage_family(p_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_decision not in ('approved', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'invalid_decision'); end if;
  select * into v_approval from public.parent_approvals
   where id = p_approval_id and family_id = p_family_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_approval.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_processed'); end if;
  if v_approval.kind <> 'allowance_request' or v_approval.ref_type <> 'child_wallets' or v_approval.ref_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_approval');
  end if;

  if p_decision = 'approved' then
    if coalesce(v_approval.amount_cents, 0) <= 0 then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
    v_description := left('Allowance request approved' || case when p_note is null or trim(p_note) = '' then '' else ': ' || trim(p_note) end, 500);
    v_credit := public.wallet_credit_child_ledger(
      p_family_id, v_approval.ref_id, v_approval.amount_cents, 'parent_top_up', v_description,
      p_actor_id, 'parent_approvals', v_approval.id
    );
    if coalesce((v_credit->>'ok')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'reason', coalesce(v_credit->>'reason', 'credit_failed'));
    end if;
  end if;

  update public.parent_approvals
     set status = p_decision::public.approval_status, decided_by = p_actor_id,
         decided_at = now(), note = left(nullif(trim(coalesce(p_note, v_approval.note, '')), ''), 1000)
   where id = v_approval.id;
  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail)
  values (p_family_id, p_actor_id, 'allowance_' || p_decision, 'parent_approvals', v_approval.id,
    'Allowance request ' || p_decision);
  return jsonb_build_object('ok', true, 'decision', p_decision, 'transaction_id', v_credit->>'transaction_id');
end;
$$;

revoke all on function public.wallet_credit_child_ledger(uuid, uuid, bigint, public.wallet_txn_type, text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.wallet_transfer(uuid, uuid, uuid, bigint, text, uuid) from public, anon;
grant execute on function public.wallet_transfer(uuid, uuid, uuid, bigint, text, uuid) to authenticated;
revoke all on function public.wallet_approve_gift(uuid, uuid, uuid) from public, anon;
grant execute on function public.wallet_approve_gift(uuid, uuid, uuid) to authenticated;
revoke all on function public.wallet_decide_spend(uuid, uuid, text, text, uuid) from public, anon;
grant execute on function public.wallet_decide_spend(uuid, uuid, text, text, uuid) to authenticated;
revoke all on function public.wallet_decide_allowance(uuid, uuid, text, text, uuid) from public, anon;
grant execute on function public.wallet_decide_allowance(uuid, uuid, text, text, uuid) to authenticated;
