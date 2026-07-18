-- ============================================================================
-- seed_finance_hub_one_family.sql — data for the new Finances sub-pages:
--   Budget Planner (budgets), Bill Manager / Auto Pay / Due Reminders (bills),
--   Savings Goals (savings_goals). Payment History reuses transactions (seed
--   those with seed_wallet_one_family.sql).
-- ----------------------------------------------------------------------------
-- Seeds ~20 bills (varied due dates / status / autopay / recurring), 8 budgets,
-- and 6 savings goals for ONE family. Requires migration 0116_bills_autopay.sql.
--
-- TARGET FAMILY: resolved reproducibly at runtime.
-- IDEMPOTENT: seeded bills replaced by name; budgets/savings created if missing.
-- RUN: npm run db:seed:finance   VERIFY: /dashboard/bills, /budgets, /savings.
-- ============================================================================

do $$
declare
  v_fam uuid := coalesce((select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1),(select fm.family_id from public.family_members fm where fm.is_active and fm.role not in ('parent','adult') group by fm.family_id order by min(fm.created_at) limit 1),(select id from public.families order by created_at limit 1));  -- reproducible (was a hardcoded prod UUID)
  v_email text := 'newworldventurellc@gmail.com';
  v_uid uuid; i int;
  bnames text[] := ARRAY['Electric','Water','Internet','Cell Phone','Car Insurance','Mortgage','Netflix','Spotify','Gym','Trash Pickup','Home Insurance','Student Loan','Credit Card','Daycare','Natural Gas','Car Payment','Life Insurance','HOA Dues','Streaming Bundle','Water Softener'];
  bcats  text[] := ARRAY['Utilities','Utilities','Internet','Phone','Insurance','Housing','Subscriptions','Subscriptions','Other','Utilities','Insurance','Loans','Loans','Other','Utilities','Loans','Insurance','Housing','Subscriptions','Other'];
  bcatn  int;
  budcats text[] := ARRAY['Groceries','Dining','Transport','Entertainment','Shopping','Utilities','Health','Kids'];
  budamt  numeric[] := ARRAY[800,300,200,150,250,350,200,300];
  gnames text[] := ARRAY['Family Vacation','Emergency Fund','New Car','Home Down Payment','College Fund','Holiday Gifts'];
  gemoji text[] := ARRAY['🏖️','🛟','🚗','🏠','🎓','🎁'];
  gtarget numeric[] := ARRAY[5000,10000,25000,60000,40000,2000];
  gcur    numeric[] := ARRAY[3200,7500,8400,15000,22000,650];
begin
  select id into v_uid from auth.users where lower(email)=lower(v_email) limit 1;
  if v_uid is null then raise notice 'Seed skipped: no user'; return; end if;
  if not exists (select 1 from public.families where id=v_fam) then raise notice 'Seed skipped: no family'; return; end if;

  -- Bills (replace by name within this family)
  delete from public.bills where family_id=v_fam and name = any(bnames);
  for i in 1 .. array_length(bnames,1) loop
    bcatn := (i % 5);
    insert into public.bills (family_id, name, amount, due_date, is_recurring, recurrence, status, category, autopay, created_by)
    values (v_fam, bnames[i], round((15 + (i * 37 % 400) + (i%9)*0.99)::numeric,2),
      (now() + ((bcatn * 4 - 6) * interval '1 day'))::date,     -- some overdue, some soon, some upcoming
      (i % 4 <> 0), case when i % 4 <> 0 then 'monthly' else null end,
      (case when i % 6 = 0 then 'paid' else 'upcoming' end)::public.bill_status,
      bcats[i], (i % 3 = 0), v_uid);
  end loop;

  -- Budgets (create if missing)
  for i in 1 .. array_length(budcats,1) loop
    if not exists (select 1 from public.budgets where family_id=v_fam and category=budcats[i]) then
      insert into public.budgets (family_id, category, amount, period, created_by)
      values (v_fam, budcats[i], budamt[i], 'monthly', v_uid);
    end if;
  end loop;

  -- Savings goals (create if missing)
  for i in 1 .. array_length(gnames,1) loop
    if not exists (select 1 from public.savings_goals where family_id=v_fam and name=gnames[i]) then
      insert into public.savings_goals (family_id, name, target_amount, current_amount, emoji, target_date, created_by)
      values (v_fam, gnames[i], gtarget[i], gcur[i], gemoji[i], (now() + (i * interval '60 days'))::date, v_uid);
    end if;
  end loop;

  raise notice 'Seeded bills / budgets / savings goals for family %', v_fam;
end $$;
