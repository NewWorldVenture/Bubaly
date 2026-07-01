-- FamilyOS :: 0109 finance RLS repair
-- ----------------------------------------------------------------------------
-- Same production-drift safeguard as 0105/0106/0107 for the Finances page's
-- tables: re-assert the canonical family-scoped policies so authenticated
-- members can read/write their money data. Idempotent.

do $$
declare t text;
begin
  foreach t in array array['financial_accounts','transactions','budgets','bills','savings_goals'] loop
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name=t and column_name='family_id') then
      execute format('alter table public.%I enable row level security;', t);
      execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
      execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
      execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
      execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
      execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
    end if;
  end loop;
end $$;
