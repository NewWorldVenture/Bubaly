-- 0112_location_realtime.sql
-- Enable Supabase Realtime for the Location (/dashboard/locator) tables so the
-- family map updates live across devices — when one member shares/moves or a
-- parent adds/edits/removes a place or geofence, everyone else sees it without
-- a manual refresh. The locator uses useRealtimeQuery (postgres_changes), which
-- only receives events for tables in the supabase_realtime publication.
--
-- Idempotent: each ADD TABLE is guarded so re-running is safe.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'member_locations'
  ) then
    alter publication supabase_realtime add table public.member_locations;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'family_places'
  ) then
    alter publication supabase_realtime add table public.family_places;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'location_events'
  ) then
    alter publication supabase_realtime add table public.location_events;
  end if;
end $$;
