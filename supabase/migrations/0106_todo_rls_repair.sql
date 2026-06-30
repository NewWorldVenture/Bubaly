-- FamilyOS :: 0106 todo_lists / todo_items RLS repair
-- ----------------------------------------------------------------------------
-- Same production-drift safeguard as 0105 (calendar_events): re-assert the
-- canonical family-scoped policies for the Tasks page's tables so authenticated
-- family members can actually read/write their tasks. Idempotent.

do $$
declare t text;
begin
  foreach t in array array['todo_lists','todo_items'] loop
    execute format('alter table public.%I enable row level security;', t);

    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);

    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);

    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);

    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;
