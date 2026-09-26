-- Bubaly :: 0325 - a screen-time limit is set by the family's managers
--
-- screen_time_limits holds each member's daily allowance, and it shipped with a
-- member-wide write policy — so did the screen-time module, which showed the
-- "set daily limit" control to everyone. A child could raise their own limit
-- to 24 hours, from the app itself or directly against the API. A parental
-- control the child can switch off is not one.
--
-- Members keep SELECT (a child sees their allowance and balance); INSERT,
-- UPDATE and DELETE need can_manage_family. The module now shows the control to
-- managers only. Self-logged usage (screen_time_entries) is unchanged: logging
-- your own time is the feature.
--
-- Pinned by docs/audit/screen-time-limit-check.sql.

do $$
declare
  p record;
begin
  if to_regclass('public.screen_time_limits') is null then
    return;
  end if;
  -- Replace whatever write policies exist (their names differ by migration).
  for p in select policyname from pg_policies
            where schemaname = 'public' and tablename = 'screen_time_limits' loop
    execute format('drop policy %I on public.screen_time_limits', p.policyname);
  end loop;
  execute 'create policy screen_time_limits_select on public.screen_time_limits for select to authenticated using (public.is_family_member(family_id))';
  execute 'create policy screen_time_limits_insert on public.screen_time_limits for insert to authenticated with check (public.can_manage_family(family_id))';
  execute 'create policy screen_time_limits_update on public.screen_time_limits for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))';
  execute 'create policy screen_time_limits_delete on public.screen_time_limits for delete to authenticated using (public.can_manage_family(family_id))';
end
$$;
