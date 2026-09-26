-- Bubaly :: 0339 - a driving record is not the driver's to erase
--
-- driving_trips is the teen-driving safety log a parent reviews: max speed,
-- hard brakes, rapid acceleration, seconds on the phone, and a score. It was
-- member FOR ALL and the view offered delete to everyone, so a teen could
-- delete (or quietly edit) the trip where they hit 90 mph or spent four
-- minutes on the phone. Logging a trip stays open to any member (trips are
-- entered by hand, for any driver); editing and deleting a logged trip is a
-- manager's, and the view now shows delete only to managers.
--
-- Pinned by docs/audit/driving-record-check.sql.

do $$
declare
  p record;
begin
  if to_regclass('public.driving_trips') is null then
    return;
  end if;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'driving_trips' loop
    execute format('drop policy %I on public.driving_trips', p.policyname);
  end loop;
  create policy driving_trips_select on public.driving_trips for select to authenticated
    using (public.is_family_member(family_id));
  create policy driving_trips_insert on public.driving_trips for insert to authenticated
    with check (public.is_family_member(family_id));
  create policy driving_trips_update on public.driving_trips for update to authenticated
    using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
  create policy driving_trips_delete on public.driving_trips for delete to authenticated
    using (public.can_manage_family(family_id));
end
$$;
