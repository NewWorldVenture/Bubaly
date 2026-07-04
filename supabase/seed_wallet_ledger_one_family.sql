-- ============================================================================
-- seed_wallet_ledger_one_family.sql — 500 rows in the CHILD ALLOWANCE LEDGER
-- (public.wallet_transactions, migration 0088) for ONE family, so the wallet
-- Activity page (/wallet/activity), each child's detail history, and the new
-- CSV "Statement" export all render against realistic data.
-- ----------------------------------------------------------------------------
-- NOTE: this is the kids' Family Wallet ledger (child_wallets / wallet_buckets /
--   wallet_transactions, 0088) — NOT the personal money-hub `transactions`
--   table (0113) seeded by seed_wallet_one_family.sql. Different feature.
--
-- WHAT IT DOES
--   1. Re-asserts family-scoped RLS on family_wallets, child_wallets,
--      wallet_buckets, wallet_transactions (drift-safe, idempotent).
--   2. Ensures the family wallet + one child_wallet (with Spend/Save/Give/Invest
--      buckets) exists for every non-manager (child/teen) member — created once
--      and reused, never duplicated. Falls back to ALL active members if the
--      family has no child members, so the seed always has wallets to fill.
--   3. Seeds 500 wallet_transactions across those child wallets + buckets with a
--      realistic spread of:
--        • type      — allowance / chore_reward / gift_received / parent_top_up /
--                      card_spend / goal_transfer / card_refund / adjustment
--        • direction — credit (money in) vs debit (money out), matched to type
--        • status    — mostly completed, some pending / requires_parent_approval
--                      / cancelled (so filters + the running balance are exercised)
--        • bucket    — the right bucket for each type (spend/save/give/invest)
--        • dates     — spanning ~180 days including a cluster today
--        • amounts   — small chore/allowance credits to larger gifts/top-ups.
--
-- TABLES: family_wallets, child_wallets, wallet_buckets, wallet_transactions.
--   ROW COUNT: 500 transactions (+ supporting wallet/bucket rows, created once).
--
-- TARGET FAMILY: 92298eb2-1a9e-4bdc-9361-677b6c01b499 (active family of
--   newworldventurellc@gmail.com). Change v_fam / v_email below if needed.
--   Requires migration 0088_family_wallet.sql applied first.
--
-- IDEMPOTENT: every seeded row is tagged metadata->>'seed' = 'wallet_ledger'
--   and deleted before re-insert; wallets/buckets are reused if present, so
--   re-running never duplicates and never touches real (non-seed) rows.
--
-- HOW TO RUN (local):
--   npm run db:seed:wallet-ledger
--     -- or --
--   psql "$SUPABASE_DB_URL" -f supabase/seed_wallet_ledger_one_family.sql
--   (also runnable by pasting into the Supabase SQL editor and pressing Run)
--
-- VERIFY: open /wallet/activity and hard-refresh — 500 transactions grouped by
--   day, the child/type/direction filters work, and the "Statement" button
--   downloads a CSV. Open a child under /wallet to see their history + per-child
--   Statement button.
-- ============================================================================

-- 1) RLS repair so the app can READ the seeded rows ---------------------------
do $$
declare t text;
begin
  foreach t in array array['family_wallets','child_wallets','wallet_buckets','wallet_transactions'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- 2) Ensure wallets + buckets, then seed 500 ledger rows ----------------------
do $$
declare
  v_fam    uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email  text := 'newworldventurellc@gmail.com';
  v_uid    uuid;
  v_children uuid[];   -- child_wallet ids to attach transactions to
  v_child  uuid;
  v_bucket uuid;
  m        record;
  i        int;
  n        int;

  -- per-template arrays (index t = 1..8)
  t_type   text[]  := array['allowance','chore_reward','gift_received','parent_top_up','card_spend','goal_transfer','card_refund','adjustment'];
  t_dir    text[]  := array['credit','credit','credit','credit','debit','debit','credit','credit'];
  t_kind   text[]  := array['spend','spend','save','spend','spend','save','spend','give'];
  t_lo     int[]   := array[300, 100, 1000, 500, 150, 500, 100, 50];
  t_hi     int[]   := array[1500, 800, 10000, 5000, 4000, 3000, 1200, 500];

  d_spend  text[]  := array['Snacks at the game','App Store','Movie ticket','Ice cream','Book fair','Bubble tea','Roblox credit','Vending machine','Bake sale','Football cards'];
  d_gift   text[]  := array['Birthday gift from Grandma','Holiday gift from Uncle Joe','Gift from Aunt Mia','Congrats from Grandpa','Tooth fairy'];
  d_chore  text[]  := array['Dishes done','Trash + recycling','Walked the dog','Cleaned room','Raked leaves','Vacuumed','Set the table','Fed the cat'];

  v_type   text;
  v_dir    text;
  v_kind   text;
  v_amt    int;
  v_desc   text;
  v_status text;
  v_when   timestamptz;
  t        int;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;

  -- the family wallet (unique per family) — created once, reused
  insert into public.family_wallets (family_id, mode, is_active, created_by)
  values (v_fam, 'ledger', true, v_uid)
  on conflict (family_id) do nothing;

  -- a child wallet + 4 buckets for each non-manager (child/teen) member
  for m in
    select id, role from public.family_members
    where family_id = v_fam and is_active and role not in ('parent','adult')
  loop
    insert into public.child_wallets (family_id, member_id, is_active, created_by)
    values (v_fam, m.id, true, v_uid)
    on conflict (family_id, member_id) do nothing;
  end loop;

  -- fallback: if the family has no child members, attach wallets to all active
  -- members so the seed still has somewhere to write (test data only).
  if not exists (select 1 from public.child_wallets where family_id = v_fam) then
    for m in select id from public.family_members where family_id = v_fam and is_active loop
      insert into public.child_wallets (family_id, member_id, is_active, created_by)
      values (v_fam, m.id, true, v_uid)
      on conflict (family_id, member_id) do nothing;
    end loop;
  end if;

  -- provision the 4 standard buckets for every child wallet that lacks them
  for m in select id from public.child_wallets where family_id = v_fam loop
    insert into public.wallet_buckets (family_id, child_wallet_id, kind, label, sort_order)
    values
      (v_fam, m.id, 'spend',  'Spend',  0),
      (v_fam, m.id, 'save',   'Save',   1),
      (v_fam, m.id, 'give',   'Give',   2),
      (v_fam, m.id, 'invest', 'Invest', 3)
    on conflict (child_wallet_id, kind) do nothing;
  end loop;

  select array_agg(id order by id) into v_children from public.child_wallets where family_id = v_fam;
  if v_children is null or array_length(v_children, 1) is null then
    raise notice 'No wallets to seed for family %, aborting.', v_fam;
    return;
  end if;
  n := array_length(v_children, 1);

  -- clear prior seed rows only (never touch real transactions)
  delete from public.wallet_transactions
  where family_id = v_fam and metadata->>'seed' = 'wallet_ledger';

  -- 500 transactions
  for i in 0..499 loop
    t      := 1 + (i % 8);
    v_type := t_type[t];
    v_dir  := t_dir[t];
    v_kind := t_kind[t];
    v_amt  := t_lo[t] + (i * 37 + t * 13) % (t_hi[t] - t_lo[t] + 1);
    v_child := v_children[1 + (i % n)];

    select id into v_bucket from public.wallet_buckets
      where child_wallet_id = v_child and kind = v_kind::public.wallet_bucket_kind limit 1;

    v_desc := case v_type
      when 'card_spend'    then d_spend[1 + (i % array_length(d_spend, 1))]
      when 'gift_received' then d_gift[1 + (i % array_length(d_gift, 1))]
      when 'chore_reward'  then 'Chore: ' || d_chore[1 + (i % array_length(d_chore, 1))]
      when 'allowance'     then 'Weekly allowance'
      when 'parent_top_up' then 'Parent top-up'
      when 'goal_transfer' then 'Into savings goal'
      when 'card_refund'   then 'Refund'
      else 'Adjustment'
    end;

    -- mostly completed; sprinkle other statuses to exercise filters + balance
    v_status := case
      when i % 17 = 0 then 'pending'
      when i % 23 = 0 then 'requires_parent_approval'
      when i % 31 = 0 then 'cancelled'
      else 'completed'
    end;

    v_when := now() - ((i % 180) || ' days')::interval - ((i % 24) || ' hours')::interval - ((i % 60) || ' minutes')::interval;

    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
       currency, description, related_type, metadata, created_by, approved_by, created_at, updated_at)
    values
      (v_fam, v_child, v_bucket, v_type::public.wallet_txn_type, v_status::public.wallet_txn_status,
       v_dir::public.wallet_txn_direction, v_amt, 'usd', v_desc, v_type,
       jsonb_build_object('seed','wallet_ledger'), v_uid,
       case when v_status = 'completed' then v_uid else null end,
       v_when, v_when);
  end loop;
end $$;

-- 3) VERIFY -------------------------------------------------------------------
select
  count(*)                                             as seeded_rows,
  count(*) filter (where direction = 'credit')         as credits,
  count(*) filter (where direction = 'debit')          as debits,
  count(distinct child_wallet_id)                      as child_wallets,
  count(distinct type)                                 as types,
  count(*) filter (where status <> 'completed')        as non_completed,
  to_char(min(created_at), 'YYYY-MM-DD')               as oldest,
  to_char(max(created_at), 'YYYY-MM-DD')               as newest
from public.wallet_transactions
where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499'
  and metadata->>'seed' = 'wallet_ledger';
