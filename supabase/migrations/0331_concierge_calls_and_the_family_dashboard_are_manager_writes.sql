-- Bubaly :: 0331 - concierge calls and the family dashboard are manager writes
--
-- concierge_calls  an outbound call placed on the family's behalf (bookings,
--                  cancellations; telephony cost once a provider is wired).
--                  Every action is manager-gated, and its comment says "RLS is
--                  only family-scoped (any member), so the server action is the
--                  authorization gate". Directly, a child could queue a call to
--                  any number with any goal, or rewrite a queued one. Writes
--                  need can_manage_family; the place cron is service role.
--
-- family_dashboard_settings  allow_child_customization / lock_to_family_default,
--                  the switches that decide whether a child may rearrange their
--                  dashboard at all. Manager-gated in the app; member FOR ALL in
--                  the database, so a child could unlock themselves.
--
-- dashboard_layouts  per-user layouts (scope 'user') and the family default
--                  (scope 'family'). A member writes only their own user-scope
--                  layout; the family default and other members' layouts are a
--                  manager's (saveFamilyDefaultLayoutAction, resetAllLayoutsAction).
--
-- Reads unchanged. Pinned by docs/audit/concierge-and-dashboard-check.sql.

do $$
declare
  t text;
  p record;
  own constant text := '(public.can_manage_family(family_id) or (scope = ''user'' and user_id = auth.uid()))';
begin
  foreach t in array array['concierge_calls', 'family_dashboard_settings', 'dashboard_layouts'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_select', t);
    if t = 'dashboard_layouts' then
      execute format('create policy %I on public.%I for insert to authenticated with check (public.is_family_member(family_id) and %s)', t || '_insert', t, own);
      execute format('create policy %I on public.%I for update to authenticated using (public.is_family_member(family_id) and %s) with check (public.is_family_member(family_id) and %s)', t || '_update', t, own, own);
      execute format('create policy %I on public.%I for delete to authenticated using (public.is_family_member(family_id) and %s)', t || '_delete', t, own);
    else
      execute format('create policy %I on public.%I for insert to authenticated with check (public.can_manage_family(family_id))', t || '_insert', t);
      execute format('create policy %I on public.%I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t || '_update', t);
      execute format('create policy %I on public.%I for delete to authenticated using (public.can_manage_family(family_id))', t || '_delete', t);
    end if;
  end loop;
end
$$;
