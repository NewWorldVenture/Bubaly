-- Bubaly :: 0340 - a screen-time log is not the child's to erase
--
-- 0325 made the daily screen-time limit a manager's. The usage it is measured
-- against, screen_time_entries, stayed member FOR ALL and the module offered
-- delete to everyone, so a child could keep their limit and delete the hours
-- that broke it. Logging stays open to any member; editing and deleting a
-- logged entry is a manager's, and the module shows delete only to managers.
--
-- Pinned by docs/audit/screen-time-log-check.sql.

do $$
declare
  p record;
begin
  if to_regclass('public.screen_time_entries') is null then
    return;
  end if;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'screen_time_entries' loop
    execute format('drop policy %I on public.screen_time_entries', p.policyname);
  end loop;
  create policy screen_time_entries_select on public.screen_time_entries for select to authenticated
    using (public.is_family_member(family_id));
  create policy screen_time_entries_insert on public.screen_time_entries for insert to authenticated
    with check (public.is_family_member(family_id));
  create policy screen_time_entries_update on public.screen_time_entries for update to authenticated
    using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
  create policy screen_time_entries_delete on public.screen_time_entries for delete to authenticated
    using (public.can_manage_family(family_id));
end
$$;
