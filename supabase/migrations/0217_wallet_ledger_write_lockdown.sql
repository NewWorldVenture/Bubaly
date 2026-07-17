-- 0217 — CRITICAL money-integrity fix: the wallet money tables shipped (0088)
-- with `is_family_member(family_id)` FOR ALL, so ANY family member — including a
-- child, who has a real Supabase session — could INSERT directly into
-- public.wallet_transactions via PostgREST and mint a `completed` `credit` to
-- their own SPEND bucket, i.e. give themselves unlimited spendable money that a
-- Bubaly Issuing card would then honour. The manager-gated app actions were the
-- only barrier; RLS did not stop a direct write.
--
-- Fix: keep SELECT open to all family members (a child views their own balance /
-- history) but restrict INSERT/UPDATE/DELETE to family managers (parent/adult)
-- via can_manage_family(). Trusted server writes (allowance cron, Stripe/Issuing
-- webhooks, the reserve-hold RPC, and the chore auto-approve reward) run with the
-- service role and BYPASS RLS, so they are unaffected — the companion app change
-- routes the chore auto-approve reward credit through the service role.
--
-- Additive + idempotent (drop policy if exists → recreate). No schema/data change.

do $$
declare t text;
begin
  foreach t in array array[
    'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules'
  ] loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    -- Drop the permissive "Members manage <t>" FOR ALL policy from 0088.
    execute format('drop policy if exists "Members manage %1$s" on public.%1$I', t);
    -- Drop our own policies if re-running.
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('drop policy if exists %1$s_mng_insert on public.%1$I', t);
    execute format('drop policy if exists %1$s_mng_update on public.%1$I', t);
    execute format('drop policy if exists %1$s_mng_delete on public.%1$I', t);
    -- Read: any family member. Write: managers only (service role bypasses RLS).
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (public.is_family_member(family_id))', t);
    execute format('create policy %1$s_mng_insert on public.%1$I for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('create policy %1$s_mng_update on public.%1$I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('create policy %1$s_mng_delete on public.%1$I for delete to authenticated using (public.can_manage_family(family_id))', t);
  end loop;
end $$;
