-- Bubaly :: 0267 A minor cannot rewrite the household's money
-- ----------------------------------------------------------------------------
-- `financial_accounts`, `transactions`, `budgets`, `bills` and `savings_goals`
-- have carried `is_family_member` on all four commands since 0006, re-asserted
-- by 0109. Membership, not role. Children have real sessions (`/kid-login` is
-- whitelisted in middleware.ts), every finance page guards on auth and plan but
-- never on role, and every finance write surface runs through the BROWSER anon
-- client with no check of its own. So all of these were true today:
--
--   * `delete from financial_accounts` — a child removes the family's current
--     account (components/modules/billing-module.tsx:834).
--   * `update bills set autopay = false` — a minor turns off the mortgage
--     autopay (components/finance/bills-view.tsx:56). Real money, no approval
--     anywhere in the path.
--   * `delete from budgets` — the Groceries budget goes, and with it every
--     over-budget alert measured against it (components/finance/budgets-view.tsx:41).
--   * `update savings_goals set current_amount = <anything>`
--     (components/finance/savings-view.tsx:35).
--
-- The application layer already says this is adults-only in three independent
-- places — `assertFinanceReader` in lib/services/finances, `riskToDecision`'s
-- view rule for RESTRICTED_READ_ROLES, and the manager-only money slice in
-- lib/ai/context/slices/money.ts. The database was the one that disagreed.
-- Same repair as 0264 and 0266: the boundary the TypeScript already enforces
-- now exists where it holds for every caller, including PostgREST.
--
-- WRITES ONLY. `select` deliberately keeps `is_family_member`:
--
--   Narrowing reads is defensible — the service layer already refuses them —
--   but it is a visible product change, not a leak being closed. "My Wallet"
--   sits in PRIMARY_NAV for every member and renders `financial_accounts` and
--   `transactions`; a teen's own money lives in the wallet/economy ledgers
--   (0196/0205/0208, locked down by 0217/0218), so narrowing here would empty
--   a page rather than lock a door. That belongs with the route and nav role
--   gating the app has almost none of — one `manage: true` item in the whole
--   catalogue — and should be decided as a product change with its own proof,
--   not folded into a security fix.
--
-- Two paths RLS will never see, fixed in code alongside this migration:
--   * `lib/services/finances` writes reached by the run executor use the
--     service role, so `updateBudget` and `createSavingsGoal` gained the same
--     assertion their seven sibling reads already had.
--   * `app/(app)/wallet/hub-actions.ts` server actions now refuse in code, so a
--     teen gets a sentence instead of a bare RLS error.
--
-- 0109 DID NOT ACTUALLY REPAIR ANYTHING. It added the four named policies
-- (`<table>_select` … `<table>_delete`) beside the `FOR ALL` policy 0006 had
-- already created — `"Members can manage financial_accounts"` and its four
-- siblings — and never dropped them. Postgres ORs permissive policies, so the
-- wide one has been the effective rule the whole time and the narrow ones were
-- decoration. Narrowing only the named four here would have been a no-op that
-- looked like a fix; `docs/audit/money-write-boundary-check.sql` caught it by
-- running as a real teen session, which is the only reason this line exists.
--
-- The same 0006 loop also covers `health_metrics`, `workout_logs`,
-- `school_classes`, `grades`, `teams` and `game_results`. Those keep their
-- `FOR ALL` policy: they are outside this change's blast-radius analysis and
-- guessing at a role boundary for a child's own grades or workouts without one
-- is how you break a product. Named here so the next person can see the shape.
--
-- Idempotent: policies dropped and recreated by name, same loop shape as 0109.

do $$
declare t text;
begin
  foreach t in array array['financial_accounts', 'transactions', 'budgets', 'bills', 'savings_goals'] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'family_id'
    ) then
      execute format('alter table public.%I enable row level security;', t);

      -- 0006's `FOR ALL` policy. Permissive policies are OR'd, so while this
      -- exists nothing below can narrow anything.
      execute format('drop policy if exists "Members can manage %1$s" on public.%1$I', t, t);

      -- Reading is unchanged; see the header for why that is deliberate.
      execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
      execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);

      execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
      execute format('create policy %1$s_insert on public.%1$I for insert with check (public.can_manage_family(family_id))', t, t);

      -- Both halves: `using` picks the rows they may touch, `with check` stops
      -- a permitted row being rewritten into another family's.
      execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
      execute format('create policy %1$s_update on public.%1$I for update using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t, t);

      execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
      execute format('create policy %1$s_delete on public.%1$I for delete using (public.can_manage_family(family_id))', t, t);
    end if;
  end loop;
end $$;
