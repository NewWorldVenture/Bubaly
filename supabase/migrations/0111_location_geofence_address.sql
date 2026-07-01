-- 0111_location_geofence_address.sql
-- Additive columns for the redesigned /dashboard/locator (Location) page:
--   • family_places.geofence_enabled — powers the "Geofences" on/off toggles.
--   • member_locations.address        — the human address shown in "Live Locations".
-- Both are backward-compatible (nullable / defaulted) and change no existing rows.
-- RLS is unchanged: both tables already carry family-scoped "Members can manage"
-- FOR ALL policies (migration 0042).

ALTER TABLE public.family_places
  ADD COLUMN IF NOT EXISTS geofence_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.member_locations
  ADD COLUMN IF NOT EXISTS address text;

-- Location History / Place Alerts read events newest-first per family.
CREATE INDEX IF NOT EXISTS idx_location_events_family_time
  ON public.location_events(family_id, occurred_at DESC);
