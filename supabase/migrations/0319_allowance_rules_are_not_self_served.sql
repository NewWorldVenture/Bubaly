-- ── A child may not set the amount of their own allowance ───────────────────
--
-- `allowance_rules` is the standing instruction that pays a child: it carries
-- `child_wallet_id`, `amount_cents`, `cadence` and `next_run_on`. The wallet
-- allowance cron (`app/api/cron/wallet-allowance/route.ts`) reads rules that are
-- due and credits the named wallet.
--
-- Its only policy was:
--
--   for all to authenticated
--     using (is_family_member(family_id)) with check (is_family_member(family_id))
--
-- `FOR ALL` covers INSERT, UPDATE and DELETE, so the rule deciding who may set
-- the amount asked only whether the caller was in the household — and the child
-- being paid is in the household.
--
-- Every write path in app/(app)/wallet/actions.ts already gates on
-- `isManager(ctx.active.role)`: saving a rule, toggling one, running one now.
-- But a server action is not a boundary against a JWT holder. Children have real
-- logins, and a PATCH to /rest/v1/allowance_rules never passes through app/.
--
-- Reproduced on a replayed database before writing this, as a child:
--
--   update public.allowance_rules set amount_cents = 100000, next_run_on = current_date;
--   -> UPDATE 1   (raised from $5.00/week to $1,000.00, scheduled for today)
--
-- The cron pays what the rule says. This is self-dealing with a straight face:
-- no exploit, no race, one authenticated request against the row that pays you.
--
-- Note for anyone reading the wallet audit trail: W-01 and W-02 closed the
-- allowance DOUBLE-PAY race (`runDueAllowancesAction` advancing the schedule by
-- id while the cron carried `.lte('next_run_on', today)`). That work examined
-- how an allowance is PAID and never asked who may set the AMOUNT. The execution
-- path was made correct while its input stayed writable by the beneficiary.
--
-- Writes now require `can_manage_family()` — the repo's existing manager
-- predicate (0003: `role in ('parent','adult') and is_active`), the same set
-- `isManager()` enforces in the actions, so no capability is added or removed
-- for a manager.
--
-- SELECT is granted EXPLICITLY here. The `FOR ALL` policy being replaced was
-- also what allowed reads, so dropping it without this would blank the allowance
-- surfaces for everyone. A child seeing "you get $5 on Fridays" is the point of
-- the feature; changing it is not.

drop policy if exists "Members manage allowance_rules" on public.allowance_rules;

drop policy if exists allowance_rules_select on public.allowance_rules;
create policy allowance_rules_select on public.allowance_rules
  for select to authenticated
  using (public.is_family_member(family_id));

drop policy if exists allowance_rules_insert on public.allowance_rules;
create policy allowance_rules_insert on public.allowance_rules
  for insert to authenticated
  with check (public.can_manage_family(family_id));

drop policy if exists allowance_rules_update on public.allowance_rules;
create policy allowance_rules_update on public.allowance_rules
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));

drop policy if exists allowance_rules_delete on public.allowance_rules;
create policy allowance_rules_delete on public.allowance_rules
  for delete to authenticated
  using (public.can_manage_family(family_id));
