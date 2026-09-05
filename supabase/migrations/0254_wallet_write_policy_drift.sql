-- 0254: Production retained the generic INSERT/UPDATE/DELETE policies created
-- by historical RLS repair alongside 0217's manager-only policies. Permissive
-- policies combine with OR, so the older rules bypassed the money write lock.
-- Remove those known legacy writes and add restrictive manager guards, so a
-- future permissive repair cannot silently reopen the same boundary.
-- No money rows, balances, account settings, or external payments are changed.
do $$
declare t text;
begin
  foreach t in array array[
    'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules'
  ] loop
    if to_regclass('public.' || t) is null then
      raise exception 'Required wallet table missing: %', t;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Members manage %1$s" on public.%1$I', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t);

    execute format('drop policy if exists %1$s_mng_insert on public.%1$I', t);
    execute format('drop policy if exists %1$s_mng_update on public.%1$I', t);
    execute format('drop policy if exists %1$s_mng_delete on public.%1$I', t);
    execute format('create policy %1$s_mng_insert on public.%1$I for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('create policy %1$s_mng_update on public.%1$I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('create policy %1$s_mng_delete on public.%1$I for delete to authenticated using (public.can_manage_family(family_id))', t);

    execute format('drop policy if exists %1$s_manager_insert_guard on public.%1$I', t);
    execute format('drop policy if exists %1$s_manager_update_guard on public.%1$I', t);
    execute format('drop policy if exists %1$s_manager_delete_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_insert_guard on public.%1$I as restrictive for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('create policy %1$s_manager_update_guard on public.%1$I as restrictive for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('create policy %1$s_manager_delete_guard on public.%1$I as restrictive for delete to authenticated using (public.can_manage_family(family_id))', t);
  end loop;
end $$;
