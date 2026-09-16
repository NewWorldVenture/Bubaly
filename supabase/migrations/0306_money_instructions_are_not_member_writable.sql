-- Bubaly :: 0306 - two numbers a child could write that a money path trusts
--
-- 0254 added RESTRICTIVE manager guards to the money tables and 0275 swept the
-- stray permissive policies off them "by shape rather than by name", because
-- "the previous three attempts each fixed the instance and left the class
-- open". Both enumerate the tables they cover:
--
--   wallet_tables  = family_wallets, child_wallets, wallet_buckets,
--                    wallet_transactions, wallet_rules
--   finance_tables = financial_accounts, transactions, budgets, bills,
--                    savings_goals
--
-- A hardcoded list is the very thing 0275's header warns about, and two tables
-- that move real money are not on it.
--
-- ── 1. allowance_rules — a standing instruction to pay ──────────────────────
--
-- One policy, `Members manage allowance_rules FOR ALL … is_family_member`, no
-- role check and no restrictive guard. The nightly cron reads it —
--
--   app/api/cron/wallet-allowance/route.ts: selects is_active rules due today,
--   then creditChildWallet(…, amountCents: rule.amount_cents)
--
-- — so the row is not a record of a payment, it is the reason one happens, on a
-- schedule, with nobody in the loop.
--
-- Measured on a replayed database with every migration applied, acting as a
-- child of the family, with both controls passing: the child INSERTED an
-- allowance rule of 100000 cents a week pointing at their own wallet. The next
-- cron run pays it.
--
-- Nothing legitimate breaks. Both writers in the product —
-- `saveAllowanceRuleAction` and `toggleAllowanceRuleAction` — already refuse a
-- non-manager in application code (`if (!isManager(ctx.active.role))`). This
-- migration only makes the database agree with the rule the application already
-- states, which is what matters for anyone calling PostgREST directly.
--
-- ── 2. invest_orders — the price of your own trade ─────────────────────────
--
-- `invest_decide_order` debits the wallet with the order's stored
-- `amount_cents` and adds its stored `shares` to the holding, and never checks
-- that the two agree with each other or with the asset. A child inserting
-- directly could record 1000 shares at a price of their choosing for one cent.
--
-- The guard here is CONSISTENCY, not authorship, because authorship is not the
-- problem: `placeInvestOrderAction` legitimately inserts as the child, and it
-- already derives both numbers server-side — `price_cents: asset.price_cents`
-- and `amount = orderAmountCents(shares, asset.price_cents)`. So requiring the
-- stored economics to match the asset refuses the forged insert and lets the
-- real one through untouched. A manager-only rule here would break placing an
-- order at all.
--
-- Checked whenever the economics are set or changed, whoever is setting them:
-- an order recording 1000 shares for a penny is wrong no matter who wrote it.
-- The trusted server (service role, or a migration or seed with no session) is
-- exempt, as elsewhere in this series.

-- ── 1 ───────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.allowance_rules') is null then
    return;
  end if;

  -- Restrictive: ANDs with the union of the permissive policies, so no
  -- permissive policy — present or added later, whatever it is called — can
  -- grant past it. This is 0254's mechanism, applied to the table its list
  -- missed.
  drop policy if exists allowance_rules_manager_insert_guard on public.allowance_rules;
  create policy allowance_rules_manager_insert_guard on public.allowance_rules
    as restrictive for insert to authenticated
    with check (public.can_manage_family(family_id));

  drop policy if exists allowance_rules_manager_update_guard on public.allowance_rules;
  create policy allowance_rules_manager_update_guard on public.allowance_rules
    as restrictive for update to authenticated
    using (public.can_manage_family(family_id))
    with check (public.can_manage_family(family_id));

  drop policy if exists allowance_rules_manager_delete_guard on public.allowance_rules;
  create policy allowance_rules_manager_delete_guard on public.allowance_rules
    as restrictive for delete to authenticated
    using (public.can_manage_family(family_id));
end
$$;

-- ── 2 ───────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.invest_orders') is null then
    return;
  end if;

  create or replace function public.invest_order_economics_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $guard$
  declare
    asset_price bigint;
  begin
    if tg_op = 'UPDATE'
       and new.shares is not distinct from old.shares
       and new.price_cents is not distinct from old.price_cents
       and new.amount_cents is not distinct from old.amount_cents then
      return new;  -- a decision, not a repricing
    end if;

    -- The trusted server may record whatever a backfill or seed needs.
    if current_user = 'service_role'
       or coalesce(auth.role(), '') = 'service_role'
       or auth.uid() is null then
      return new;
    end if;

    if new.amount_cents is distinct from (new.shares * new.price_cents)::bigint then
      raise exception
        'invest order amount % does not match % shares at %', new.amount_cents, new.shares, new.price_cents
        using errcode = '23514';
    end if;

    select price_cents into asset_price from public.invest_assets where id = new.asset_id;
    if asset_price is not null and new.price_cents is distinct from asset_price then
      raise exception
        'invest order price % is not this asset''s price %', new.price_cents, asset_price
        using errcode = '23514';
    end if;

    return new;
  end;
  $guard$;

  comment on function public.invest_order_economics_guard() is
    'An invest order must be priced at the asset and its amount must equal shares x price. invest_decide_order debits the wallet with the stored amount and credits the stored shares without checking either, and placeInvestOrderAction already derives both server-side — so this refuses a forged direct insert without touching the real path.';

  drop trigger if exists trg_invest_order_economics_guard on public.invest_orders;
  create trigger trg_invest_order_economics_guard
    before insert or update on public.invest_orders
    for each row execute function public.invest_order_economics_guard();
end
$$;
