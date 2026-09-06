-- Behavioural proof for 0267, run as a real `authenticated` session under RLS.
--
-- A child has a real session in this product. These are the writes they could
-- make against the household's money before this migration.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare
  fam        uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  parent_uid uuid := 'e0000000-0000-4000-8000-000000000001';
  teen_uid   uuid := 'e0000000-0000-4000-8000-000000000002';
  acct       uuid;
  bill       uuid;
  budget     uuid;
  goal       uuid;
  n          int;
  blocked    boolean;
  r          record;
begin
  insert into public.families (id, name) values (fam, 'Money') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'mp@example.test'), (teen_uid, 'mt@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true), (fam, teen_uid, 'Teen', 'teen', true)
  on conflict do nothing;

  insert into public.financial_accounts (family_id, name, balance)
  values (fam, 'Current account', 2400.00) returning id into acct;
  insert into public.budgets (family_id, category, amount)
  values (fam, 'Groceries', 600.00) returning id into budget;
  insert into public.bills (family_id, name, amount, due_date, autopay)
  values (fam, 'Mortgage', 1800.00, current_date + 7, true) returning id into bill;
  insert into public.savings_goals (family_id, name, target_amount, current_amount)
  values (fam, 'Summer trip', 2000.00, 500.00) returning id into goal;

  -- ── No policy may quietly re-open what this one closes ───────────────────
  -- 0109 narrowed the four named policies and left 0006's `FOR ALL` beside
  -- them; Postgres ORs permissive policies, so for years the wide one was the
  -- real rule and the narrow ones were decoration. Assert the WHOLE set, not
  -- just that the intended policies exist — that is the check that would have
  -- caught it, and the one that catches the next one.
  for r in
    select tablename, policyname, cmd, coalesce(qual, with_check) as expr
      from pg_policies
     where schemaname = 'public'
       and tablename in ('financial_accounts', 'transactions', 'budgets', 'bills', 'savings_goals')
       and cmd <> 'SELECT'
       and coalesce(qual, with_check) not like '%can_manage_family%'
  loop
    raise exception 'policy %.% (%) still writes on membership alone: %',
      r.tablename, r.policyname, r.cmd, r.expr;
  end loop;

  -- ── As the teen ──────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', teen_uid::text, true);
  set local role authenticated;

  -- Reading is unchanged and deliberately so: this migration closes writes.
  select count(*) into n from public.financial_accounts where family_id = fam;
  if n <> 1 then raise exception 'reads changed; 0267 was meant to leave them alone'; end if;

  -- 1. The family's bank account row.
  delete from public.financial_accounts where id = acct;
  if found then raise exception 'a teen deleted the household bank account'; end if;

  -- 2. Autopay on the mortgage. Real money, and nothing else in the path asks.
  update public.bills set autopay = false where id = bill;
  if found then raise exception 'a teen switched off autopay on a bill'; end if;
  select autopay into blocked from public.bills where id = bill;
  if not blocked then raise exception 'autopay was switched off after all'; end if;

  -- 3. The budget every over-budget alert is measured against.
  delete from public.budgets where id = budget;
  if found then raise exception 'a teen deleted a household budget'; end if;

  -- 4. A savings balance with no ledger behind it.
  update public.savings_goals set current_amount = 9999.00 where id = goal;
  if found then raise exception 'a teen rewrote a savings balance'; end if;

  -- 5. And cannot invent a transaction against the household's money.
  blocked := false;
  begin
    insert into public.transactions (family_id, account_id, name, amount)
    values (fam, acct, 'Pocket money', -50.00);
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'a teen wrote a household transaction'; end if;

  -- ── As the parent ────────────────────────────────────────────────────────
  -- The boundary is only right if it still lets the adults run the household.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);

  update public.bills set autopay = false where id = bill;
  if not found then raise exception 'a parent cannot manage their own bill'; end if;

  insert into public.transactions (family_id, account_id, name, amount)
  values (fam, acct, 'Groceries', -50.00);

  update public.budgets set amount = 700.00 where id = budget;
  if not found then raise exception 'a parent cannot adjust their own budget'; end if;

  delete from public.savings_goals where id = goal;
  if not found then raise exception 'a parent cannot close their own savings goal'; end if;

  reset role;
  delete from public.transactions where family_id = fam;
  delete from public.bills where family_id = fam;
  delete from public.budgets where family_id = fam;
  delete from public.savings_goals where family_id = fam;
  delete from public.financial_accounts where family_id = fam;
  delete from public.family_members where family_id = fam;
  delete from public.families where id = fam;
  delete from auth.users where id in (parent_uid, teen_uid);
  raise notice 'money write boundary check passed';
end $$;
