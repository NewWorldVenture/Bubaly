-- 0218 — Money-integrity fix for the family ECONOMY (points/tokens), the sibling
-- of the wallet ledger (0217). The economy tables shipped (0096) with a single
-- `"Members manage" … FOR ALL … is_family_member(family_id)` policy, so a child
-- (real Supabase session) could INSERT a `credit` into public.currency_transactions
-- via PostgREST and MINT unlimited family tokens, then redeem them for parent-
-- defined rewards (screen time, treats, cash-outs). Balance = Σ(credits−debits).
--
-- Fix (mirrors 0217): keep SELECT open to all members; restrict writes to
-- can_manage_family(). Trusted writes bypass RLS via the service role:
--   • token AWARD  -> awardTokensAction (manager-gated app action)
--   • token DEBIT  -> decideRedemptionAction (manager) / loyalty_redeem_reward()
--                     RPC (SECURITY DEFINER, service_role-only)
-- EXCEPTION: `economy_redemptions` — a CHILD legitimately INSERTs a *pending*
-- redemption request (requestRedemptionAction), so its INSERT stays open to
-- members; only UPDATE/DELETE (approve/deny/fulfil) are manager-only.
--
-- Additive + idempotent. No schema/data change.

do $$
declare t text;
begin
  -- Manager-only writes; member reads. (currency ledger + config + rewards)
  foreach t in array array['family_currencies','currency_transactions','economy_rewards'] loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Members manage %1$s" on public.%1$I', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('drop policy if exists %1$s_mng_insert on public.%1$I', t);
    execute format('drop policy if exists %1$s_mng_update on public.%1$I', t);
    execute format('drop policy if exists %1$s_mng_delete on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (public.is_family_member(family_id))', t);
    execute format('create policy %1$s_mng_insert on public.%1$I for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('create policy %1$s_mng_update on public.%1$I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('create policy %1$s_mng_delete on public.%1$I for delete to authenticated using (public.can_manage_family(family_id))', t);
  end loop;

  -- economy_redemptions: members may READ + INSERT (a child requests a
  -- redemption); only managers may UPDATE/DELETE (approve / deny / fulfil).
  if to_regclass('public.economy_redemptions') is not null then
    alter table public.economy_redemptions enable row level security;
    drop policy if exists "Members manage economy_redemptions" on public.economy_redemptions;
    drop policy if exists economy_redemptions_select on public.economy_redemptions;
    drop policy if exists economy_redemptions_insert on public.economy_redemptions;
    drop policy if exists economy_redemptions_mng_update on public.economy_redemptions;
    drop policy if exists economy_redemptions_mng_delete on public.economy_redemptions;
    create policy economy_redemptions_select on public.economy_redemptions
      for select to authenticated using (public.is_family_member(family_id));
    create policy economy_redemptions_insert on public.economy_redemptions
      for insert to authenticated with check (public.is_family_member(family_id));
    create policy economy_redemptions_mng_update on public.economy_redemptions
      for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
    create policy economy_redemptions_mng_delete on public.economy_redemptions
      for delete to authenticated using (public.can_manage_family(family_id));
  end if;
end $$;
