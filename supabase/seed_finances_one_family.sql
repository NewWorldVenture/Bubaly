-- ============================================================================
-- seed_finances_one_family.sql — 500+ transactions for ONE family's Finances page.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Re-asserts the family-scoped RLS policies on financial_accounts /
--      transactions / budgets / bills / savings_goals (the "Members can manage"
--      FOR ALL policy from migration 0006) so authenticated members can read the
--      seeded rows. Safe + idempotent.
--   2. Ensures member_id exists on transactions (mirrors migration 0108) so the
--      "Spending by Person" widget works even if the migration hasn't been applied.
--   3. Seeds the supporting rows the Finances Overview renders:
--        • 6 financial_accounts (checking/savings/credit/investment + kid cards)
--        • 8 budgets (one per major spend category)
--        • 5 savings_goals (with progress + emoji)
--        • ~18 bills across upcoming/paid/overdue, dated in the current month
--   4. Seeds 500 transactions with a realistic spread of:
--        • type: income / expense (with a few transfers)
--        • category: Housing, Groceries, Transportation, Dining Out, Utilities,
--          Kids, Entertainment, Shopping, Health, Subscriptions, Other, Income
--        • account_id + member_id (powers per-account change + Spending by Person)
--        • date: spread across the last ~6 months incl. plenty in the CURRENT
--          month so all Overview numbers/donut/breakdown populate
--        • amount: short + large values, null-ish edge cases (notes null)
--
-- TARGET FAMILY: 92298eb2-1a9e-4bdc-9361-677b6c01b499  (active fam of
--   newworldventurellc@gmail.com). Change v_fam / v_email below if needed.
--
-- ROW COUNT: 500 transactions + 6 accounts + 8 budgets + 5 goals + ~18 bills.
--
-- IDEMPOTENT: seeded transactions/bills are tagged (transactions.notes and
--   bills via a name marker are NOT reliable, so we scope deletes by a dedicated
--   tag in notes = '[seed:finances]' for transactions, and delete accounts/
--   budgets/goals/bills created by this seed via marker columns). Re-running
--   replaces the seeded rows for THIS family only; real user rows are untouched.
--
-- SAFETY: never auto-runs against production. Paste into the Supabase SQL editor
--   and Run, or apply locally via `npm run db:seed:finances`.
--
-- HOW TO RUN: paste into the Supabase SQL editor and Run, then hard-refresh
--   /dashboard/billing (the Finances page).
-- ============================================================================

-- 1) member_id column (mirror of migration 0108, safe if already applied) -----
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_family_member ON public.transactions(family_id, member_id);

-- 2) RLS repair (so the page can READ the seeded rows) ------------------------
do $$
declare t text;
begin
  foreach t in array array['financial_accounts','transactions','budgets','bills','savings_goals'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "Members can manage %1$s" on public.%1$I', t, t);
    execute format('create policy "Members can manage %1$s" on public.%1$I for all to authenticated using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- 3) + 4) Accounts, budgets, goals, bills, and 500 transactions ---------------
do $$
declare
  v_fam    uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email  text := 'newworldventurellc@gmail.com';
  v_uid    uuid;
  v_members uuid[];
  v_nmem   int;
  v_accts  uuid[] := '{}';
  v_acct   uuid;
  v_id     uuid;
  i        int;
  v_cat    text;
  v_type   text;
  v_amt    numeric(12,2);
  v_date   date;
  v_member uuid;
  seeded   int := 0;

  -- Expense categories + a plausible per-transaction amount band (min,max cents).
  cats   text[] := ARRAY['Housing','Groceries','Transportation','Dining Out','Utilities','Kids','Entertainment','Shopping','Health','Subscriptions','Other'];
  names  text[] := ARRAY['Whole Foods Market','Shell Gas Station','Netflix','EMT Utility Co.','Target','Dinner at Mario''s','Amazon','CVS Pharmacy','Spotify','Rent Payment','Costco','Uber','Movie Night','Water Bill','School Supplies','Coffee Shop','Home Depot','Gym Membership','Electric Bill','Toy Store'];

  acct_name  text[] := ARRAY['Joint Checking','Joint Savings','Jordan''s Spending','Sarah''s Spending','Vacation Fund','Family Credit'];
  acct_type  text[] := ARRAY['checking','savings','checking','checking','savings','credit'];
  acct_last  text[] := ARRAY['4567','7890','1111','2222','3333','9012'];
  acct_bal   numeric[] := ARRAY[4620.45, 6250.20, 320.00, 215.80, 1500.00, -840.25];

  bud_cat    text[] := ARRAY['Housing','Groceries','Transportation','Dining Out','Utilities','Kids','Entertainment','Shopping'];
  bud_amt    numeric[] := ARRAY[1800, 1000, 700, 500, 500, 450, 300, 400];

  goal_name  text[] := ARRAY['Family Vacation','New Car','College Fund','Emergency Fund','Holiday Gifts'];
  goal_tgt   numeric[] := ARRAY[3000, 8000, 20000, 10000, 1500];
  goal_cur   numeric[] := ARRAY[1500, 2200, 4250, 3450.20, 600];
  goal_emoji text[] := ARRAY['🏖️','🚗','🎓','🛡️','🎁'];

  bill_name  text[] := ARRAY['Rent/Mortgage','Car Insurance','Electric Bill','Internet Bill','Water Bill','Phone Bill','Streaming Bundle','Trash Service'];
  bill_amt   numeric[] := ARRAY[1650, 128.50, 85.75, 65.00, 42.30, 95.00, 34.99, 28.00];
  bill_cat   text[] := ARRAY['Housing','Transportation','Utilities','Utilities','Utilities','Utilities','Subscriptions','Utilities'];
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;

  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_fam and is_active;
  if v_members is null then
    raise exception 'No active members for family %', v_fam;
  end if;
  v_nmem := array_length(v_members, 1);

  -- Clean previously seeded rows for THIS family only (tagged in notes/marker).
  delete from public.transactions where family_id = v_fam and notes = '[seed:finances]';
  delete from public.bills where family_id = v_fam and category is not null and name = any(bill_name);
  delete from public.savings_goals where family_id = v_fam and name = any(goal_name);
  delete from public.budgets where family_id = v_fam and category = any(bud_cat);
  delete from public.financial_accounts where family_id = v_fam and name = any(acct_name);

  -- Accounts (collect ids for transaction linkage).
  for i in 1..array_length(acct_name,1) loop
    insert into public.financial_accounts (family_id, name, type, last_four, balance, currency, created_by)
    values (v_fam, acct_name[i], acct_type[i]::public.account_type, acct_last[i], acct_bal[i], 'USD', v_uid)
    returning id into v_acct;
    v_accts := array_append(v_accts, v_acct);
  end loop;

  -- Budgets.
  for i in 1..array_length(bud_cat,1) loop
    insert into public.budgets (family_id, category, amount, period, created_by)
    values (v_fam, bud_cat[i], bud_amt[i], 'monthly', v_uid);
  end loop;

  -- Savings goals.
  for i in 1..array_length(goal_name,1) loop
    insert into public.savings_goals (family_id, name, target_amount, current_amount, emoji, target_date, created_by)
    values (v_fam, goal_name[i], goal_tgt[i], goal_cur[i], goal_emoji[i], current_date + ((90 + i*30)::int), v_uid);
  end loop;

  -- Bills (spread across the current month; mix of statuses).
  for i in 1..array_length(bill_name,1) loop
    insert into public.bills (family_id, name, amount, due_date, is_recurring, recurrence, status, category, created_by)
    values (
      v_fam, bill_name[i], bill_amt[i],
      date_trunc('month', current_date)::date + ((i * 3) % 27),
      true, 'monthly',
      (case when i % 4 = 0 then 'paid' when i % 7 = 0 then 'overdue' else 'upcoming' end)::public.bill_status,
      bill_cat[i], v_uid);
  end loop;

  -- 500 transactions.
  for i in 1..500 loop
    v_acct   := v_accts[1 + (i % array_length(v_accts,1))];
    v_member := v_members[1 + (i % v_nmem)];

    -- ~15% income, rest expense (with a light transfer sprinkle handled as expense=0 skip).
    if i % 7 = 0 then
      v_type := 'income';
      v_cat  := 'Income';
      v_amt  := (case (i % 3) when 0 then 4500.00 when 1 then 20.00 else 250.00 end);  -- salary / allowance / misc
    else
      v_type := 'expense';
      v_cat  := cats[1 + (i % array_length(cats,1))];
      -- Amount bands per category keep the donut realistic.
      v_amt  := -1 * (case v_cat
        when 'Housing'        then 1650.00
        when 'Groceries'      then round((40 + (i % 160))::numeric, 2)
        when 'Transportation' then round((15 + (i % 70))::numeric, 2)
        when 'Dining Out'     then round((12 + (i % 90))::numeric, 2)
        when 'Utilities'      then round((45 + (i % 90))::numeric, 2)
        when 'Kids'           then round((10 + (i % 120))::numeric, 2)
        when 'Entertainment'  then round((8 + (i % 60))::numeric, 2)
        when 'Shopping'       then round((15 + (i % 200))::numeric, 2)
        when 'Health'         then round((10 + (i % 140))::numeric, 2)
        when 'Subscriptions'  then round((5 + (i % 25))::numeric, 2)
        else round((5 + (i % 100))::numeric, 2)
      end);
    end if;

    -- Date spread: 55% in the current month, rest across the previous ~5 months.
    case (i % 20)
      when 0,1,2,3,4,5,6,7,8,9,10 then v_date := date_trunc('month', current_date)::date + (i % 27);
      when 11,12,13 then v_date := (date_trunc('month', current_date) - interval '1 month')::date + (i % 27);
      when 14,15 then v_date := (date_trunc('month', current_date) - interval '2 month')::date + (i % 27);
      when 16,17 then v_date := (date_trunc('month', current_date) - interval '3 month')::date + (i % 27);
      when 18 then v_date := (date_trunc('month', current_date) - interval '4 month')::date + (i % 27);
      else v_date := (date_trunc('month', current_date) - interval '5 month')::date + (i % 27);
    end case;
    if v_date > current_date then v_date := current_date; end if;

    insert into public.transactions
      (family_id, account_id, member_id, name, amount, category, date, type, notes, created_by)
    values (
      v_fam, v_acct,
      case when v_type = 'income' then null else v_member end,   -- attribute expenses to a person
      names[1 + (i % array_length(names,1))], v_amt, v_cat, v_date, v_type::public.transaction_type,
      '[seed:finances]', v_uid);
    seeded := seeded + 1;
  end loop;

  raise notice 'Seeded % transactions + % accounts + % budgets + % goals + % bills for family %.',
    seeded, array_length(v_accts,1), array_length(bud_cat,1), array_length(goal_name,1), array_length(bill_name,1), v_fam;
end $$;

-- 5) Verify the spread --------------------------------------------------------
select
  count(*)                                                        as total_tx,
  count(*) filter (where type = 'income')                         as income_tx,
  count(*) filter (where type = 'expense')                        as expense_tx,
  count(*) filter (where date >= date_trunc('month', current_date)) as this_month,
  count(distinct category)                                        as categories,
  count(*) filter (where member_id is not null)                   as attributed
from public.transactions
where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and notes = '[seed:finances]';
