-- ============================================================================
-- seed_wallet_one_family.sql — data for the "My Wallet" hub (/wallet) for ONE
-- family: 4 accounts, 4 cards, 3 passes, 3 reward programs, and 500 transactions.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Re-asserts family-scoped RLS on financial_accounts, transactions,
--      wallet_cards, wallet_passes, wallet_rewards (drift-safe, idempotent).
--   2. Ensures the wallet's accounts / cards / passes / reward programs exist
--      (created once, reused thereafter — never duplicated).
--   3. Seeds 500 transactions across the accounts with a realistic spread of:
--        • type      — expense / income / transfer
--        • status    — posted / pending / cleared / scheduled / failed
--        • category  — Groceries, Dining, Gas, Shopping, Subscriptions, …
--        • merchant  — real-world names (Amazon, Netflix, Shell Gas, …)
--        • member    — some attributed to a family member (e.g. allowance)
--        • dates     — spanning ~180 days incl. today + a few future (scheduled)
--        • amounts   — small to large, plus null category/merchant edge cases.
--
-- TABLES: financial_accounts, wallet_cards, wallet_passes, wallet_rewards,
--         transactions.   ROW COUNT: 500 transactions (+ ~14 supporting rows).
--
-- TARGET FAMILY: 92298eb2-1a9e-4bdc-9361-677b6c01b499 (active family of
--   newworldventurellc@gmail.com). Change v_fam / v_email below if needed.
--   Requires migration 0113_wallet_hub.sql applied first (adds
--   transactions.status/merchant + wallet_cards/passes/rewards).
--
-- IDEMPOTENT: seeded transactions are tagged notes='[seed:wallet]' and deleted
--   before re-insert; accounts/cards/passes/rewards are reused if present.
--
-- HOW TO RUN (local):
--   npm run db:seed:wallet
--     -- or --
--   psql "$SUPABASE_DB_URL" -f supabase/seed_wallet_one_family.sql
--   (also runnable by pasting into the Supabase SQL editor and pressing Run)
--
-- VERIFY: open /wallet and hard-refresh. Overview totals populate; the
--   Accounts tab shows accounts + recent transactions; the right rail shows
--   cards, passes, and rewards; the Transactions tab lists all 500 with search.
-- ============================================================================

-- 1) RLS repair -------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['financial_accounts','transactions','wallet_cards','wallet_passes','wallet_rewards'] loop
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name=t and column_name='family_id') then
      execute format('alter table public.%I enable row level security;', t);
      execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
      execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
      execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
      execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
      execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
    end if;
  end loop;
end $$;

-- 2) + 3) Wallet contents + 500 transactions --------------------------------
do $$
declare
  v_fam  uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email text := 'newworldventurellc@gmail.com';
  v_uid  uuid;
  v_members uuid[];  n_members int;
  v_kid  uuid;

  v_acct_ids uuid[] := '{}';
  v_cid uuid;

  -- account specs: name, type, institution, last_four, balance
  a_names text[] := ARRAY['Family Checking','Joint Savings','Kids Savings','Cash Wallet'];
  a_types text[] := ARRAY['checking','savings','savings','checking'];
  a_inst  text[] := ARRAY['Chase','Chase','Ally','Cash'];
  a_four  text[] := ARRAY['3456','7890','1357','0000'];
  a_bal   numeric[] := ARRAY[2735.40, 2585.35, 1250.00, 150.00];

  -- card specs: name, brand, kind, last_four, available_cents, limit_cents
  c_names text[] := ARRAY['Family Credit Card','Debit Card','Gas Card','Store Card'];
  c_brand text[] := ARRAY['visa','mastercard','other','other'];
  c_kind  text[] := ARRAY['credit','debit','gas','store'];
  c_four  text[] := ARRAY['4242','5678','9012','3456'];
  c_avail bigint[] := ARRAY[125000, 215075, 15000, 7525];
  c_limit bigint[] := ARRAY[500000, NULL, 50000, 20000];

  -- pass specs: name, kind, status, detail
  p_names text[] := ARRAY['Sam''s Club','AMC Stubs','Gym Membership'];
  p_kind  text[] := ARRAY['membership','loyalty','membership'];
  p_stat  text[] := ARRAY['Member','Member','Premium Plan'];
  p_det   text[] := ARRAY['Expires Dec 31, 2025','5,240 points','Renews Jun 15, 2025'];

  -- reward specs: name, kind, balance, unit, value_cents, program
  r_names text[] := ARRAY['Chase Ultimate Rewards','Delta SkyMiles','Amex Cash Back'];
  r_kind  text[] := ARRAY['points','miles','cashback'];
  r_bal   numeric[] := ARRAY[1250, 1600, 87.50];
  r_unit  text[] := ARRAY['points','miles','$'];
  r_val   bigint[] := ARRAY[12500, 20000, 8750];
  r_prog  text[] := ARRAY['Chase','Delta','American Express'];

  -- transaction pools
  exp_merch text[] := ARRAY['Grocery Store','Amazon','Netflix','Target','Shell Gas','Starbucks','Costco','Uber','Spotify','Home Depot','CVS Pharmacy','Chipotle','Apple','Walmart','Chevron','Best Buy','Trader Joe''s','McDonald''s','Delta Air Lines','Marriott'];
  exp_cat   text[] := ARRAY['Groceries','Shopping','Subscriptions','Shopping','Gas','Dining','Groceries','Travel','Subscriptions','Home','Health','Dining','Shopping','Groceries','Gas','Shopping','Groceries','Dining','Travel','Travel'];
  inc_merch text[] := ARRAY['Payroll Deposit','Interest Payment','Refund','Zelle from Grandma','Tax Refund','Ethan Allowance'];
  inc_cat   text[] := ARRAY['Income','Income','Refund','Income','Income','Allowance'];
  xfer_name text[] := ARRAY['Transfer to Joint Savings','Transfer to Kids Savings','Transfer to Checking','Autosave to Savings'];

  i int; v_type text; v_status text; v_name text; v_merch text; v_cat text;
  v_amt numeric; v_when date; v_acct uuid; v_member uuid; ai int; seeded int := 0;
begin
  select id into v_uid from auth.users where lower(email)=lower(v_email) limit 1;
  if v_uid is null then raise notice 'Seed skipped: no auth user for %', v_email; return; end if;
  if not exists (select 1 from public.families where id=v_fam) then raise notice 'Seed skipped: family % not found', v_fam; return; end if;

  select array_agg(id order by created_at) into v_members from public.family_members where family_id=v_fam and is_active;
  n_members := coalesce(array_length(v_members,1),0);
  select id into v_kid from public.family_members where family_id=v_fam and is_active and role in ('child','teen') order by created_at limit 1;

  -- Accounts (reuse-or-create), capture ids in order.
  for i in 1 .. array_length(a_names,1) loop
    select id into v_cid from public.financial_accounts where family_id=v_fam and name=a_names[i] limit 1;
    if v_cid is null then
      insert into public.financial_accounts (family_id, name, type, institution, last_four, balance, created_by)
      values (v_fam, a_names[i], a_types[i]::public.account_type, a_inst[i], a_four[i], a_bal[i], v_uid)
      returning id into v_cid;
    else
      update public.financial_accounts set type=a_types[i]::public.account_type, institution=a_inst[i], last_four=a_four[i], balance=a_bal[i] where id=v_cid;
    end if;
    v_acct_ids := array_append(v_acct_ids, v_cid);
  end loop;

  -- Cards
  for i in 1 .. array_length(c_names,1) loop
    if not exists (select 1 from public.wallet_cards where family_id=v_fam and name=c_names[i]) then
      insert into public.wallet_cards (family_id, name, brand, kind, last_four, available_cents, limit_cents, sort_order, created_by)
      values (v_fam, c_names[i], c_brand[i], c_kind[i], c_four[i], c_avail[i], c_limit[i], i, v_uid);
    end if;
  end loop;

  -- Passes
  for i in 1 .. array_length(p_names,1) loop
    if not exists (select 1 from public.wallet_passes where family_id=v_fam and name=p_names[i]) then
      insert into public.wallet_passes (family_id, name, kind, status, detail, sort_order, created_by)
      values (v_fam, p_names[i], p_kind[i], p_stat[i], p_det[i], i, v_uid);
    end if;
  end loop;

  -- Rewards
  for i in 1 .. array_length(r_names,1) loop
    if not exists (select 1 from public.wallet_rewards where family_id=v_fam and name=r_names[i]) then
      insert into public.wallet_rewards (family_id, name, kind, balance, unit, value_cents, program, sort_order, created_by)
      values (v_fam, r_names[i], r_kind[i], r_bal[i], r_unit[i], r_val[i], r_prog[i], i, v_uid);
    end if;
  end loop;

  -- Wipe previously seeded transactions (tagged), then reseed 500.
  delete from public.transactions where family_id=v_fam and notes='[seed:wallet]';

  for i in 1 .. 500 loop
    ai := 1 + (i % array_length(v_acct_ids,1));
    v_acct := v_acct_ids[ai];
    v_member := null;

    -- type mix: ~70% expense, ~18% income, ~12% transfer
    if (i % 8) = 0 then v_type := 'transfer';
    elsif (i % 8) in (1,2) then v_type := 'income';
    else v_type := 'expense'; end if;

    if v_type = 'expense' then
      v_merch := exp_merch[1 + (i % array_length(exp_merch,1))];
      v_cat   := exp_cat[1 + (i % array_length(exp_cat,1))];
      v_name  := v_merch;
      v_amt   := round((5 + (i * 7 % 480) + ((i % 13) * 0.37))::numeric, 2);
    elsif v_type = 'income' then
      ai := 1 + (i % array_length(inc_merch,1));
      v_name  := inc_merch[ai];
      v_merch := inc_merch[ai];
      v_cat   := inc_cat[ai];
      v_amt   := round((15 + (i * 11 % 900))::numeric, 2);
      if v_name = 'Ethan Allowance' then v_member := v_kid; v_amt := 25.00; end if;
    else
      v_name  := xfer_name[1 + (i % array_length(xfer_name,1))];
      v_merch := null;
      v_cat   := 'Transfer';
      v_amt   := round((25 + (i * 9 % 600))::numeric, 2);
    end if;

    -- status: newest-ish pending, some scheduled in the future, rest posted/cleared
    if (i % 37) = 0 then v_status := 'pending';
    elsif (i % 53) = 0 then v_status := 'scheduled';
    elsif (i % 97) = 0 then v_status := 'failed';
    elsif (i % 3) = 0 then v_status := 'cleared';
    else v_status := 'posted'; end if;

    -- dates: mostly last ~180 days (newest last), a few future for 'scheduled'
    if v_status = 'scheduled' then
      v_when := (now() + ((i % 20) * interval '1 day'))::date;
    else
      v_when := (now() - ((500 - i) * interval '8.6 hours'))::date;
    end if;

    -- edge cases: occasional null category/merchant
    if (i % 41) = 0 then v_cat := null; end if;
    if (i % 47) = 0 and v_type = 'expense' then v_merch := null; end if;

    insert into public.transactions
      (family_id, account_id, member_id, name, merchant, amount, category, date, type, status, notes, created_by)
    values
      (v_fam, v_acct, v_member, v_name, v_merch, v_amt, v_cat, v_when, v_type::public.transaction_type, v_status, '[seed:wallet]', v_uid);
    seeded := seeded + 1;
  end loop;

  raise notice 'Seeded % transactions + accounts/cards/passes/rewards for family %', seeded, v_fam;
end $$;
