-- Behavioural proof for 0267 (and 0275, which now owns the rule), run as a
-- real `authenticated` session under RLS.
--
-- A child has a real session in this product. These are the writes they could
-- make against the household's money before this migration.
--
-- 0275 re-asserts 0267's four named policies on each of the five finance tables
-- and adds the RESTRICTIVE `<t>_manager_*_guard` backstops the wallet group has
-- had since 0254. Both layers spell the same predicate — `can_manage_family` —
-- so what is under test below is that predicate, whichever layer bites first.
--
-- NEGATIVE CONTROL. Five of the checks below are refusals, and a refusal on its
-- own names no rule:
--
--   * check 5 catches `insufficient_privilege`, and 42501 is equally what
--     Postgres raises for a missing table GRANT, a column-level denial, or a
--     session whose JWT never resolved to a user at all;
--   * checks 1-4 are quieter still — a DELETE the teen may not see reports
--     exactly what a DELETE of a row that was never seeded reports: nothing.
--
-- The parent block at the foot of this probe is a positive control, and a good
-- one, but it moves the actor AND the predicate together. So before any of the
-- five refusals is attempted, the SAME teen — same user, same `authenticated`
-- role, same JWT, same tables, same statements, same policies — performs all
-- five writes against a second household they really do manage. Only
-- `can_manage_family(family_id)` differs. If any of those five is refused, this
-- probe reports CONTROL FAILED and names the reason, rather than crediting a
-- refusal it did not measure to 0267/0275.
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam        uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  -- The second household, for the negative control. The teen is a 'parent' in
  -- THIS one, and nothing else about their session changes.
  ctl_fam    uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeecc';
  parent_uid uuid := 'e0000000-0000-4000-8000-000000000001';
  teen_uid   uuid := 'e0000000-0000-4000-8000-000000000002';
  acct       uuid;
  bill       uuid;
  budget     uuid;
  goal       uuid;
  ctl_acct   uuid;
  ctl_bill   uuid;
  ctl_budget uuid;
  ctl_goal   uuid;
  why        text;
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

  -- The control household. Seeded HERE, as the superuser, but never written to
  -- from here: every control write below happens after the session switch, in
  -- the teen's own `authenticated` session. That ordering is the whole point —
  -- the document-vault probe passed for a year because its setup rows went in
  -- before the switch and nothing the teen did afterwards had to succeed.
  insert into public.families (id, name) values (ctl_fam, 'Money (control)') on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (ctl_fam, teen_uid, 'Grown-up elsewhere', 'parent', true)
  on conflict do nothing;

  insert into public.financial_accounts (family_id, name, balance)
  values (ctl_fam, 'Control account', 10.00) returning id into ctl_acct;
  insert into public.budgets (family_id, category, amount)
  values (ctl_fam, 'Control budget', 10.00) returning id into ctl_budget;
  insert into public.bills (family_id, name, amount, due_date, autopay)
  values (ctl_fam, 'Control bill', 10.00, current_date + 7, true) returning id into ctl_bill;
  insert into public.savings_goals (family_id, name, target_amount, current_amount)
  values (ctl_fam, 'Control goal', 100.00, 1.00) returning id into ctl_goal;

  -- ── No policy may quietly re-open what this one closes ───────────────────
  -- 0109 narrowed the four named policies and left 0006's `FOR ALL` beside
  -- them; Postgres ORs permissive policies, so for years the wide one was the
  -- real rule and the narrow ones were decoration. Assert the WHOLE set, not
  -- just that the intended policies exist — that is the check that would have
  -- caught it, and the one that catches the next one.
  -- Match the predicate EXACTLY, and look at both halves. Two blind spots in
  -- the `not like '%can_manage_family%'` test this replaces, both reproduced:
  --
  --   * a MENTION is not a gate. `is_family_member(family_id) or
  --     can_manage_family(family_id)` contains the string, so it sailed through
  --     while re-opening every write to every active member — including
  --     caregivers and guests. That widening is how the false green below was
  --     built, and this loop is what should have caught it.
  --   * `coalesce(qual, with_check)` stops at the first non-null, so an UPDATE
  --     policy's WITH CHECK was never examined: a correct USING beside a
  --     widened WITH CHECK reads as intended and lets a teen move a row.
  --
  -- All 30 write policies on these five tables are spelled exactly
  -- `can_manage_family(family_id)` today, permissive and restrictive alike, so
  -- this is not over-tight. A deliberate future rewording is meant to fail here
  -- and be re-verified by a human rather than pattern-matched past.
  for r in
    select tablename, policyname, cmd, permissive,
           coalesce(qual, '(none)') as using_expr,
           coalesce(with_check, '(none)') as check_expr
      from pg_policies
     where schemaname = 'public'
       and tablename in ('financial_accounts', 'transactions', 'budgets', 'bills', 'savings_goals')
       and cmd <> 'SELECT'
       and (coalesce(qual,       'can_manage_family(family_id)') <> 'can_manage_family(family_id)'
         or coalesce(with_check, 'can_manage_family(family_id)') <> 'can_manage_family(family_id)')
  loop
    raise exception 'policy %.% (% %) does not gate writes on can_manage_family alone: using=%, with check=%',
      r.tablename, r.policyname, r.permissive, r.cmd, r.using_expr, r.check_expr;
  end loop;

  -- ── As the teen ──────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', teen_uid::text, true);
  set local role authenticated;

  -- Reading is unchanged and deliberately so: this migration closes writes.
  select count(*) into n from public.financial_accounts where family_id = fam;
  if n <> 1 then raise exception 'reads changed; 0267 was meant to leave them alone'; end if;

  -- The same read assertion for the three tables checks 2-4 write to, and it is
  -- load-bearing for exactly the same reason. Checks 2, 3 and 4 are SILENT
  -- refusals: they conclude from `not found`. A row this session cannot SEE
  -- reports `not found` identically to a row it may not WRITE. The negative
  -- control below does not separate those two, because it works on `ctl_fam`,
  -- where the teen is a manager and so can both see and write.
  --
  -- Reproduced, not theorised: narrowing `bills_select`, `budgets_select` and
  -- `savings_goals_select` from is_family_member to can_manage_family — a read
  -- change this migration's header explicitly says it is NOT making — left
  -- checks 2-4 refusing on visibility while testing nothing at all, and BOTH
  -- this probe and its pre-control version printed "money write boundary check
  -- passed". These three lines are what turn that back into a red.
  select count(*) into n from public.bills where id = bill;
  if n <> 1 then raise exception 'the teen cannot SEE the household bill, so check 2 would be a visibility refusal credited to the write boundary; reads were meant to stay on is_family_member'; end if;
  select count(*) into n from public.budgets where id = budget;
  if n <> 1 then raise exception 'the teen cannot SEE the household budget, so check 3 would be a visibility refusal credited to the write boundary; reads were meant to stay on is_family_member'; end if;
  select count(*) into n from public.savings_goals where id = goal;
  if n <> 1 then raise exception 'the teen cannot SEE the household savings goal, so check 4 would be a visibility refusal credited to the write boundary; reads were meant to stay on is_family_member'; end if;

  -- ── NEGATIVE CONTROL ─────────────────────────────────────────────────────
  -- Before asking whether this session is refused on `fam`, prove it is a
  -- session that can write at all. It is this same statement, on this same
  -- table, through this same policy, by this same user — against `ctl_fam`,
  -- where `can_manage_family` is true. Anything that fails here (a revoked
  -- GRANT, a column denial, a JWT that resolved to nobody, a later restrictive
  -- policy keyed on something other than role) would ALSO refuse the five
  -- writes below, and be silently credited to 0267/0275.
  if current_user <> 'authenticated' then
    raise exception 'CONTROL FAILED: these writes are running as %, not as authenticated, so RLS is not the thing being measured', current_user;
  end if;
  if auth.uid() is distinct from teen_uid then
    raise exception 'CONTROL FAILED: auth.uid() is % rather than the teen, so nothing below is this teen''s refusal', coalesce(auth.uid()::text, 'null');
  end if;

  -- Control for check 5 — the only refusal that announces itself, and the one
  -- whose SQLSTATE a missing GRANT shares.
  why := null;
  begin
    insert into public.transactions (family_id, account_id, name, amount)
    values (ctl_fam, ctl_acct, 'Weekly shop', -5.00);
    get diagnostics n = row_count;
    if n <> 1 then why := 'the INSERT reported no row'; end if;
  exception when insufficient_privilege then why := sqlerrm;
  end;
  if why is not null then
    raise exception 'CONTROL FAILED: the teen was refused an ORDINARY transaction in a family they DO manage (%), so a refusal in check 5 would prove nothing about 0267/0275', why;
  end if;

  -- Control for check 2.
  why := null;
  begin
    update public.bills set autopay = false where id = ctl_bill;
    if not found then why := 'the UPDATE matched no row'; end if;
  exception when insufficient_privilege then why := sqlerrm;
  end;
  if why is not null then
    raise exception 'CONTROL FAILED: the teen could not switch autopay off on a bill they DO manage (%), so a refusal in check 2 would prove nothing about 0267/0275', why;
  end if;

  -- Control for check 4.
  why := null;
  begin
    update public.savings_goals set current_amount = 9999.00 where id = ctl_goal;
    if not found then why := 'the UPDATE matched no row'; end if;
  exception when insufficient_privilege then why := sqlerrm;
  end;
  if why is not null then
    raise exception 'CONTROL FAILED: the teen could not rewrite a savings balance they DO manage (%), so a refusal in check 4 would prove nothing about 0267/0275', why;
  end if;

  -- Control for check 3.
  why := null;
  begin
    delete from public.budgets where id = ctl_budget;
    if not found then why := 'the DELETE matched no row'; end if;
  exception when insufficient_privilege then why := sqlerrm;
  end;
  if why is not null then
    raise exception 'CONTROL FAILED: the teen could not delete a budget they DO manage (%), so a refusal in check 3 would prove nothing about 0267/0275', why;
  end if;

  -- Control for check 1. Last, because `transactions.account_id` is ON DELETE
  -- SET NULL and this takes the control transaction's account out from under it.
  why := null;
  begin
    delete from public.financial_accounts where id = ctl_acct;
    if not found then why := 'the DELETE matched no row'; end if;
  exception when insufficient_privilege then why := sqlerrm;
  end;
  if why is not null then
    raise exception 'CONTROL FAILED: the teen could not delete a bank account they DO manage (%), so a refusal in check 1 would prove nothing about 0267/0275', why;
  end if;

  -- None of the five touched `fam`, so no count or read-back below moves. The
  -- control household is torn down with the rest at the foot of this block.

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
  -- Only the RLS refusal proves the boundary. `when others` would report this
  -- held after a future migration renames a column here — verified: renaming
  -- `name` leaves the probe printing "money write boundary check passed".
  exception when insufficient_privilege then blocked := true;
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
  delete from public.transactions where family_id in (fam, ctl_fam);
  delete from public.bills where family_id in (fam, ctl_fam);
  delete from public.budgets where family_id in (fam, ctl_fam);
  delete from public.savings_goals where family_id in (fam, ctl_fam);
  delete from public.financial_accounts where family_id in (fam, ctl_fam);
  delete from public.family_members where family_id in (fam, ctl_fam);
  delete from public.families where id in (fam, ctl_fam);
  delete from auth.users where id in (parent_uid, teen_uid);
  raise notice 'money write boundary check passed (the same teen first made all five writes against a household they DO manage, so the five refusals are can_manage_family and not a grant, a column or a dead JWT)';
end $$;
