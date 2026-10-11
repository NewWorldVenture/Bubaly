-- Bubaly :: 0478 - a family goal is shaped by the household, and removed by
--                   its managers
-- ----------------------------------------------------------------------------
-- From the 2026-10-10 finance-deletes audit (proposed-goals-role-rls.sql, the SQL
-- half of audit/finance-deletes-fix). Numbered 0478 by owner decision of
-- 2026-10-10; the SQL is the proposal's, unchanged.
--
-- public.goals still carries the generic 0004_rls.sql policies: goals_select,
-- goals_insert, goals_update and goals_delete are all plain
-- public.is_family_member(family_id), so any active member — a guest ("view
-- limited shared events only") or a caregiver ("view only the areas assigned
-- to them") included — can create, edit or delete the family's goals directly
-- against the API.
--
-- 632ce745d put the rule in the service (lib/services/goals/index.ts):
--
--   * deleteGoal        -> assertGoalRemover: parent or adult (or system)
--   * createGoal,
--     updateGoal,
--     setGoalProgress   -> assertGoalWriter: anyone but a guest or a caregiver
--
-- This mirrors it at the database, the same shape as 0378 (a savings goal is a
-- manager write):
--
--   * select  - every member, unchanged;
--   * insert  - a member whose role is neither guest nor caregiver;
--   * update  - the same, on both the old and the new row;
--   * delete  - public.can_manage_family(family_id) (parent / adult).
--
-- The role comes from public.family_role(family_id) (0003), the lookup 0464's
-- household_write_is_not_a_guests() already uses. It does not filter on
-- is_active, so each policy also keeps public.is_family_member(family_id),
-- which does. coalesce() makes an unknown role (no row) refused rather than
-- admitted. The service role bypasses RLS, matching the service's `system`
-- allowance for cron work.
--
-- Idempotent: every policy is dropped if it exists and recreated.

do $$
begin
  if to_regclass('public.goals') is null then
    return;
  end if;
  execute 'drop policy if exists goals_select on public.goals';
  execute 'drop policy if exists goals_insert on public.goals';
  execute 'drop policy if exists goals_update on public.goals';
  execute 'drop policy if exists goals_delete on public.goals';

  execute 'create policy goals_select on public.goals for select to authenticated '
          'using (public.is_family_member(family_id))';

  execute 'create policy goals_insert on public.goals for insert to authenticated '
          'with check (public.is_family_member(family_id) '
          'and coalesce(public.family_role(family_id)::text, ''guest'') not in (''guest'', ''caregiver''))';

  execute 'create policy goals_update on public.goals for update to authenticated '
          'using (public.is_family_member(family_id) '
          'and coalesce(public.family_role(family_id)::text, ''guest'') not in (''guest'', ''caregiver'')) '
          'with check (public.is_family_member(family_id) '
          'and coalesce(public.family_role(family_id)::text, ''guest'') not in (''guest'', ''caregiver''))';

  execute 'create policy goals_delete on public.goals for delete to authenticated '
          'using (public.can_manage_family(family_id))';
end
$$;
