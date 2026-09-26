-- Bubaly :: 0323 - a savings goal is written by the family's managers
--
-- Every other wallet table is manager-write: child_wallets, wallet_buckets and
-- wallet_transactions carry can_manage_family policies (and restrictive
-- guards). wallet_goals kept its original "Members manage wallet_goals" FOR ALL,
-- so any member — the child the goal belongs to included — could, directly
-- against the API:
--
--   * set saved_cents to the target and mark a goal reached with no money
--     behind it. Only wallet_fund_goal (0208, SECURITY DEFINER, manager-gated)
--     is meant to move saved_cents, and it does so together with the Save-bucket
--     debit that pays for it;
--   * delete a funded goal. The Save-bucket debit has already happened, and the
--     goal row is the only record of how much a parent set aside for it.
--
-- The app never writes this table from a member session except through
-- manager-gated actions (createGoalAction checks isManager; funding goes
-- through the RPC), so members keep SELECT and managers keep INSERT, UPDATE and
-- DELETE. wallet_fund_goal is SECURITY DEFINER and unaffected.
--
-- Pinned by docs/audit/wallet-goal-manager-write-check.sql.

do $$
begin
  if to_regclass('public.wallet_goals') is null then
    return;
  end if;
  execute 'drop policy if exists "Members manage wallet_goals" on public.wallet_goals';
  execute 'drop policy if exists wallet_goals_select on public.wallet_goals';
  execute 'drop policy if exists wallet_goals_insert on public.wallet_goals';
  execute 'drop policy if exists wallet_goals_update on public.wallet_goals';
  execute 'drop policy if exists wallet_goals_delete on public.wallet_goals';
  execute 'create policy wallet_goals_select on public.wallet_goals for select to authenticated using (public.is_family_member(family_id))';
  execute 'create policy wallet_goals_insert on public.wallet_goals for insert to authenticated with check (public.can_manage_family(family_id))';
  execute 'create policy wallet_goals_update on public.wallet_goals for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))';
  execute 'create policy wallet_goals_delete on public.wallet_goals for delete to authenticated using (public.can_manage_family(family_id))';
end
$$;
