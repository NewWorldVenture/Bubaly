-- ============================================================================
-- seed_finances_one_family.sql — populate the Finances page for ONE family.
-- ----------------------------------------------------------------------------
-- WHAT (all scoped to The Kramer Family, 92298eb2-…):
--   0. RLS repair on the finance tables (so the page can READ the rows).
--   1. 4 financial_accounts (checking / savings / credit / investment).
--   2. 500 transactions across ~10 months — income + expense (+ transfers),
--      every category, spanning this month (Overview) and past months (Reports
--      8-month trend). (>= 500 rows)
--   3. 8 budgets, 10 bills (upcoming/paid/overdue), 4 savings goals — so the
--      Budgets / Bills / Savings tabs all populate.
--
-- TABLES: financial_accounts, transactions, budgets, bills, savings_goals.
-- IDEMPOTENT: transactions tagged notes '[seed:finance]'; aux rows matched by
--   their seeded names — all cleared before re-insert (this family only).
-- HOW TO RUN: paste into the Supabase SQL editor, Run, then hard-refresh
--   /dashboard/billing.
-- ============================================================================

-- 0) Column + RLS repair -----------------------------------------------------
-- Ensures the per-member column exists even if migration 0110 hasn't run yet.
alter table public.transactions
  add column if not exists member_id uuid references public.family_members(id) on delete set null;

do $$
declare t text;
begin
  foreach t in array array['financial_accounts','transactions','budgets','bills','savings_goals'] loop
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

-- 1) – 3) Data ---------------------------------------------------------------
do $$
declare
  v_fam   uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email text := 'newworldventurellc@gmail.com';
  v_uid uuid; v_accts uuid[] := '{}'; a_check uuid; a_save uuid; a_credit uuid; a_invest uuid;
  v_members uuid[]; v_member uuid;
  i int; seeded int := 0;
  v_type public.transaction_type; v_cat text; v_name text; v_amt numeric(12,2); v_date date; v_acct uuid;

  exp_cats text[] := array['Groceries','Dining','Utilities','Housing','Transportation','Entertainment','Healthcare','Shopping','Subscriptions','Kids','Insurance','Education'];
  exp_names text[] := array['Whole Foods','Chipotle','City Power & Light','Mortgage','Shell Gas','Movie Night','CVS Pharmacy','Amazon','Netflix','Soccer Club','State Farm','Tuition'];
  exp_base numeric[] := array[95,38,140,1850,55,42,60,75,16,85,130,320];
  inc_names text[] := array['Paycheck','Freelance Project','Interest','Tax Refund','Dividend','Bonus'];
begin
  if not exists (select 1 from public.families where id = v_fam) then raise exception 'Family % not found', v_fam; end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id order by created_at) into v_members from public.family_members where family_id = v_fam and is_active;

  -- 1) Accounts (idempotent by name).
  delete from public.financial_accounts where family_id = v_fam
    and name in ('Everyday Checking','Family Savings','Rewards Credit Card','Brokerage');
  insert into public.financial_accounts (family_id,name,type,institution,last_four,balance,currency,created_by)
    values (v_fam,'Everyday Checking','checking','Chase','4821', 8450.75,'USD',v_uid) returning id into a_check;
  insert into public.financial_accounts (family_id,name,type,institution,last_four,balance,currency,created_by)
    values (v_fam,'Family Savings','savings','Ally','9130', 24300.00,'USD',v_uid) returning id into a_save;
  insert into public.financial_accounts (family_id,name,type,institution,last_four,balance,currency,created_by)
    values (v_fam,'Rewards Credit Card','credit','Amex','1007', -1240.55,'USD',v_uid) returning id into a_credit;
  insert into public.financial_accounts (family_id,name,type,institution,last_four,balance,currency,created_by)
    values (v_fam,'Brokerage','investment','Fidelity','5567', 41120.10,'USD',v_uid) returning id into a_invest;
  v_accts := array[a_check,a_save,a_credit,a_invest];

  -- 2) 500 transactions across ~10 months.
  delete from public.transactions where family_id = v_fam and notes like '%[seed:finance]%';
  for i in 1..500 loop
    v_date := current_date - ((i * 3) % 300);   -- spread over ~10 months, dense recent
    if i % 9 = 0 then
      v_type := 'income';
      v_name := inc_names[1 + (i % array_length(inc_names,1))];
      v_cat  := 'Income';
      v_amt  := case v_name when 'Paycheck' then 3200 when 'Freelance Project' then 850 when 'Bonus' then 1500
                            when 'Tax Refund' then 1200 when 'Dividend' then 180 else 24 end
                + ((i % 7) * 11);
      v_acct := a_check;
    elsif i % 50 = 0 then
      v_type := 'transfer';
      v_name := 'Transfer to Savings';
      v_cat  := 'Transfer';
      v_amt  := 250 + ((i % 5) * 50);
      v_acct := a_save;
    else
      v_type := 'expense';
      v_cat  := exp_cats [1 + (i % array_length(exp_cats,1))];
      v_name := exp_names[1 + (i % array_length(exp_names,1))];
      v_amt  := exp_base [1 + (i % array_length(exp_base,1))] + ((i * 7) % 40) - 15;
      if v_amt < 4 then v_amt := 4 + (i % 20); end if;
      v_acct := case when i % 3 = 0 then a_credit else a_check end;
    end if;

    -- Attribute to a family member (self gets income; expenses spread across all).
    if v_members is null or array_length(v_members,1) is null then
      v_member := null;
    elsif v_type = 'income' then
      v_member := v_members[1];
    else
      v_member := v_members[1 + (i % array_length(v_members,1))];
    end if;

    insert into public.transactions (family_id,account_id,member_id,name,amount,category,date,type,notes,created_by)
    values (v_fam, v_acct, v_member, v_name, v_amt, v_cat, v_date, v_type, 'Auto-imported. [seed:finance]', v_uid);
    seeded := seeded + 1;
  end loop;

  -- 3a) Budgets (monthly, idempotent by category).
  delete from public.budgets where family_id = v_fam
    and category in ('Groceries','Dining','Utilities','Transportation','Entertainment','Shopping','Healthcare','Kids');
  insert into public.budgets (family_id,category,amount,period,created_by) values
    (v_fam,'Groceries',700,'monthly',v_uid),(v_fam,'Dining',300,'monthly',v_uid),
    (v_fam,'Utilities',450,'monthly',v_uid),(v_fam,'Transportation',250,'monthly',v_uid),
    (v_fam,'Entertainment',200,'monthly',v_uid),(v_fam,'Shopping',350,'monthly',v_uid),
    (v_fam,'Healthcare',200,'monthly',v_uid),(v_fam,'Kids',300,'monthly',v_uid);

  -- 3b) Bills (idempotent by name).
  delete from public.bills where family_id = v_fam and name in
    ('Mortgage','Electric','Water','Internet','Phone','Car Insurance','Streaming Bundle','Gym','Trash & Recycling','Credit Card Payment');
  insert into public.bills (family_id,name,amount,due_date,is_recurring,recurrence,status,category,created_by) values
    (v_fam,'Mortgage',1850, current_date + 5,  true,'monthly','upcoming','Housing',v_uid),
    (v_fam,'Electric',148,  current_date + 9,  true,'monthly','upcoming','Utilities',v_uid),
    (v_fam,'Water',58,      current_date - 2,  true,'monthly','overdue','Utilities',v_uid),
    (v_fam,'Internet',70,   current_date + 12, true,'monthly','upcoming','Utilities',v_uid),
    (v_fam,'Phone',95,      current_date - 20, true,'monthly','paid','Utilities',v_uid),
    (v_fam,'Car Insurance',132, current_date + 18, true,'monthly','upcoming','Insurance',v_uid),
    (v_fam,'Streaming Bundle',46, current_date - 6, true,'monthly','paid','Subscriptions',v_uid),
    (v_fam,'Gym',40,        current_date + 2,  true,'monthly','upcoming','Health',v_uid),
    (v_fam,'Trash & Recycling',32, current_date - 1, true,'monthly','overdue','Utilities',v_uid),
    (v_fam,'Credit Card Payment',350, current_date + 7, true,'monthly','upcoming','Debt',v_uid);

  -- 3c) Savings goals (idempotent by name).
  delete from public.savings_goals where family_id = v_fam and name in
    ('Emergency Fund','Family Vacation','New Car','Holidays');
  insert into public.savings_goals (family_id,name,target_amount,current_amount,target_date,emoji,created_by) values
    (v_fam,'Emergency Fund',10000, 6500, current_date + 180, '🛟', v_uid),
    (v_fam,'Family Vacation',5000, 2200, current_date + 120, '🏖️', v_uid),
    (v_fam,'New Car',20000, 8000, current_date + 400, '🚗', v_uid),
    (v_fam,'Holidays',1500, 900, current_date + 90, '🎁', v_uid);

  raise notice 'Seeded % transactions + 4 accounts / 8 budgets / 10 bills / 4 goals for family %.', seeded, v_fam;
end $$;

-- Verify ---------------------------------------------------------------------
select
  (select count(*) from public.transactions where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and notes like '%[seed:finance]%') as transactions,
  (select count(*) from public.transactions where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and type='income' and notes like '%[seed:finance]%') as income_txns,
  (select count(*) from public.transactions where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499' and date >= date_trunc('month', current_date) and notes like '%[seed:finance]%') as this_month,
  (select count(*) from public.financial_accounts where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499') as accounts,
  (select count(*) from public.budgets where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499') as budgets,
  (select count(*) from public.bills where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499') as bills,
  (select count(*) from public.savings_goals where family_id='92298eb2-1a9e-4bdc-9361-677b6c01b499') as goals;
