-- Bubaly :: 0337 - the family's emergency contacts and plans are a manager's
--
-- family_emergency_contacts holds who to call in an emergency and who is
-- "Allowed to pick up kids" (can_pickup, shown as "Pickup approved");
-- family_emergency_plans holds where to meet and what to do. The generic
-- family actions refuse writes to both from anyone but a manager
-- (lib/family/actions.ts MANAGER_ONLY), but the tables were member FOR ALL, so
-- directly a child could approve a stranger for pickup, change the number
-- listed for a grandparent, or rewrite the meeting place. Writes need
-- can_manage_family; reads unchanged.
--
-- Pinned by docs/audit/emergency-plan-check.sql.

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['family_emergency_contacts', 'family_emergency_plans'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_manage_family(family_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.can_manage_family(family_id))', t || '_delete', t);
  end loop;
end
$$;
