-- Bubaly :: 0298 - the rest of 0088's loop, given 0217's boundary
-- ----------------------------------------------------------------------------
-- 0217 narrowed writes to can_manage_family on FIVE wallet tables —
-- family_wallets, child_wallets, wallet_buckets, wallet_transactions,
-- wallet_rules — and 0254/0275 re-assert that set with RESTRICTIVE guards so a
-- later by-name drop cannot quietly reopen it.
--
-- Six tables created by the SAME 0088 loop were never added to that set, and
-- still carry its permissive `FOR ALL … USING is_family_member WITH CHECK
-- is_family_member`:
--
--   allowance_rules  wallet_goals  gift_links
--   gift_payments    babysitter_profiles  babysitter_payments
--
-- allowance_rules is the one that moves money. The direct mint 0217 closed is
-- reopened one level up: a child cannot insert a wallet_transaction, but they
-- CAN insert a RULE — and the nightly cron (app/api/cron/wallet-allowance)
-- runs under the service role, bypasses RLS, and calls creditChildWallet with
-- `rule.amount_cents` and no check on who wrote the rule. One row, one tick,
-- real spendable funds on a Bubaly Issuing card. Confirmed on a full migration
-- replay as a real child session: the wallet_transactions insert is refused
-- (0217/0254 hold) and `insert into allowance_rules (… amount_cents 999999 …)`
-- returns INSERT 0 1.
--
-- The other five are the same shape with a smaller blast radius: a gift link a
-- child can mint or re-point, a gift payment a child can mark approved, a
-- savings goal or babysitter rate a child can rewrite.
--
-- NO LEGITIMATE FLOW BREAKS. Every app write path to all six is already
-- manager-gated in code — saveAllowanceRuleAction, toggleAllowanceRuleAction,
-- runDueAllowancesAction, createGoalAction, fundGoalAction, createGiftLinkAction,
-- approveGiftAction, dismissGiftAction, saveBabysitterAction,
-- archiveBabysitterAction and recordBabysitterPaymentAction each open with
-- `if (!isManager(ctx.active.role))`, and isManager is parent|adult, which is
-- exactly can_manage_family. The one write that is NOT a manager's is the
-- public gift pledge (app/gift/actions.ts), and it goes through
-- createServiceClient() — service role, RLS bypassed — so it is unaffected.
-- This migration moves the database to where the code already stands.
--
-- READS ARE UNCHANGED: is_family_member. A child seeing their own allowance
-- rule, savings goal or gift link is the product working.

do $$
declare
  t        text;
  pol      record;
  swept    int := 0;
  remaining int;
  money_adjacent text[] := array[
    'allowance_rules', 'wallet_goals', 'gift_links',
    'gift_payments', 'babysitter_profiles', 'babysitter_payments'
  ];
begin
  foreach t in array money_adjacent loop
    -- Older deployments may predate one of these; skip quietly rather than fail
    -- a release, the way 0275 does for the household finance group.
    if to_regclass('public.' || t) is null then continue; end if;

    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_mng_insert on public.%1$I', t);
    execute format('create policy %1$s_mng_insert on public.%1$I for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_mng_update on public.%1$I', t);
    execute format('create policy %1$s_mng_update on public.%1$I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_mng_delete on public.%1$I', t);
    execute format('create policy %1$s_mng_delete on public.%1$I for delete to authenticated using (public.can_manage_family(family_id))', t);

    -- The restrictive backstop 0254 gave the wallet ledger. A RESTRICTIVE policy
    -- is ANDed with whatever permissive policies exist, so a stray permissive
    -- write policy re-added later cannot reopen the boundary on its own.
    execute format('drop policy if exists %1$s_manager_insert_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_insert_guard on public.%1$I as restrictive for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_update_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_update_guard on public.%1$I as restrictive for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_delete_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_delete_guard on public.%1$I as restrictive for delete to authenticated using (public.can_manage_family(family_id))', t);

    -- Sweep every OTHER permissive write policy, by shape rather than by name.
    -- 0088's is called "Members manage <table>", but naming it here is how the
    -- next drift survives: 0217 narrowed five tables by name and these six were
    -- simply not on the list.
    for pol in
      select p.polname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = t
        and p.polpermissive
        and p.polcmd in ('a','w','d','*')   -- insert, update, delete, all
        and p.polname not in (t || '_mng_insert', t || '_mng_update', t || '_mng_delete')
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, t);
      swept := swept + 1;
      raise notice '0298: dropped stray permissive write policy %.%', t, pol.polname;
    end loop;
  end loop;

  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (money_adjacent)
    and p.polpermissive
    and p.polcmd in ('a','w','d','*')
    and p.polname not in (c.relname || '_mng_insert', c.relname || '_mng_update', c.relname || '_mng_delete');

  if remaining <> 0 then
    raise exception '0298 FAILED: % permissive write policy(ies) still on the allowance/gift tables after the sweep', remaining;
  end if;

  raise notice '0298 OK: % stray write policy(ies) swept; writes on % table(s) are managers-only', swept, array_length(money_adjacent, 1);
end $$;
