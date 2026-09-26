-- Bubaly :: 0351 - a behavior log is not the child's to erase
--
-- behavior_logs is the chart a parent keeps: positive and challenging moments
-- per child, with points, feeding the 6-week trend and the AI behavior coach.
-- It was member FOR ALL and the module offered delete to everyone, so a child
-- could delete the challenging entries about themselves, or edit them into
-- positive ones. Logging stays open to any member; editing and deleting a
-- logged entry is a manager's, and the module shows delete only to managers.
-- (The same shape as driving_trips, 0339, and screen_time_entries, 0340.)
--
-- Pinned by docs/audit/behavior-log-check.sql.

do $$
declare
  p record;
begin
  if to_regclass('public.behavior_logs') is null then
    return;
  end if;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'behavior_logs' loop
    execute format('drop policy %I on public.behavior_logs', p.policyname);
  end loop;
  create policy behavior_logs_select on public.behavior_logs for select to authenticated
    using (public.is_family_member(family_id));
  create policy behavior_logs_insert on public.behavior_logs for insert to authenticated
    with check (public.is_family_member(family_id));
  create policy behavior_logs_update on public.behavior_logs for update to authenticated
    using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
  create policy behavior_logs_delete on public.behavior_logs for delete to authenticated
    using (public.can_manage_family(family_id));
end
$$;
