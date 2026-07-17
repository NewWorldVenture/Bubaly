-- 0220 — Money-integrity fix for KID INVESTING, the third family ledger (after
-- the wallet 0217 and the economy 0218). The invest tables shipped (0097) with
-- the same `"Members manage" … FOR ALL … is_family_member(family_id)` policy, so
-- a child (real Supabase session) could INSERT/UPDATE `invest_holdings` directly
-- via PostgREST and mint themselves shares (portfolio value), bypassing the
-- parent-approved order flow.
--
-- Fix (mirrors 0217/0218): keep SELECT open to all members (a child views their
-- portfolio) but restrict writes to can_manage_family(). `invest_holdings` is
-- only ever written by the SECURITY DEFINER `invest_decide_order` RPC (manager
-- approves), which bypasses RLS, so approvals keep working.
-- EXCEPTION: `invest_orders` — a CHILD legitimately INSERTs a *pending* buy/sell
-- order (placeInvestOrderAction), so its INSERT stays open to members; only
-- UPDATE/DELETE (approve / cancel) are manager-only.
--
-- Additive + idempotent. No schema/data change.

do $$
begin
  -- invest_holdings: manager (or the SECURITY DEFINER RPC) writes only; members read.
  if to_regclass('public.invest_holdings') is not null then
    alter table public.invest_holdings enable row level security;
    drop policy if exists "Members manage invest_holdings" on public.invest_holdings;
    drop policy if exists invest_holdings_select on public.invest_holdings;
    drop policy if exists invest_holdings_mng_insert on public.invest_holdings;
    drop policy if exists invest_holdings_mng_update on public.invest_holdings;
    drop policy if exists invest_holdings_mng_delete on public.invest_holdings;
    create policy invest_holdings_select on public.invest_holdings
      for select to authenticated using (public.is_family_member(family_id));
    create policy invest_holdings_mng_insert on public.invest_holdings
      for insert to authenticated with check (public.can_manage_family(family_id));
    create policy invest_holdings_mng_update on public.invest_holdings
      for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
    create policy invest_holdings_mng_delete on public.invest_holdings
      for delete to authenticated using (public.can_manage_family(family_id));
  end if;

  -- invest_orders: members may READ + INSERT (a child places a pending order);
  -- only managers may UPDATE/DELETE (approve / cancel).
  if to_regclass('public.invest_orders') is not null then
    alter table public.invest_orders enable row level security;
    drop policy if exists "Members manage invest_orders" on public.invest_orders;
    drop policy if exists invest_orders_select on public.invest_orders;
    drop policy if exists invest_orders_insert on public.invest_orders;
    drop policy if exists invest_orders_mng_update on public.invest_orders;
    drop policy if exists invest_orders_mng_delete on public.invest_orders;
    create policy invest_orders_select on public.invest_orders
      for select to authenticated using (public.is_family_member(family_id));
    create policy invest_orders_insert on public.invest_orders
      for insert to authenticated with check (public.is_family_member(family_id));
    create policy invest_orders_mng_update on public.invest_orders
      for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
    create policy invest_orders_mng_delete on public.invest_orders
      for delete to authenticated using (public.can_manage_family(family_id));
  end if;
end $$;
