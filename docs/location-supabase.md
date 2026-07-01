# Location — data model & wiring

The **Location** nav item (`/dashboard/locator`) renders
`components/modules/locator-module.tsx`. **Every value is read from Supabase** —
there is no mock/static data.

## Tables

| Table | Role |
| --- | --- |
| `family_places` | Places + geofences: `name`, `icon`, `address`, `latitude`, `longitude`, `radius_m`, **`geofence_enabled`**. Drives the map pins, Geofences rail (toggles), and Place labels. |
| `member_locations` | One live row per member: `latitude`, `longitude`, `battery`, `place_id`, **`address`**, `is_sharing`, `updated_at`. Drives the map markers, member chips, and Live Locations list. |
| `location_events` | Arrivals/departures: `member_id`, `place_id`, `place_name`, `event_type` (`arrived`/`left`/`ping`), `occurred_at`. Drives Place Alerts and Location History. |

All three carry the family-scoped `"Members can manage <table>"` FOR ALL RLS
policy (migration `0042`). `member_locations` writes are additionally self-only
(a member may only post their own position) via the server action.

### Migration `0111_location_geofence_address.sql`
Adds `family_places.geofence_enabled boolean default true` (Geofence toggles) and
`member_locations.address text` (Live Locations address line), plus an index on
`location_events(family_id, occurred_at desc)`. Additive + backward-compatible.

## Where each element comes from

- **Member chips** — `members` + `member_locations` (current place label via `place_id`).
- **Map** — a stylized panel; pins are projected from lat/lng by `projectPoints`
  (shared bounding box for places + live members). Style dropdown (Traffic/
  Standard/Satellite), zoom, and Locate are all functional.
- **Live Locations** — members with `is_sharing` + coords; shows place, address,
  "since" time (`sinceLabel`), and battery band (`batteryTone`).
- **Place Alerts** — `arrivalAlerts` (recent `arrived` events).
- **Geofences** — `family_places`; the switch writes `geofence_enabled` via the
  `setGeofenceEnabled` server action.
- **Location History** — `groupHistoryByDay` buckets events into Today/Yesterday/…
  with a distinct-places counter and a today timeline.

## Interactions (all persisted)

Add Place / Add Geofence + edit + delete (`savePlace` / `deletePlace`), geofence
on/off toggle (`setGeofenceEnabled`), Share/Stop Location (`updateMyLocation` /
`setLocationSharing`, uses the browser Geolocation + Battery APIs), Refresh, and
per-member focus. Loading skeleton, empty states, toasts, confirm-on-delete, and
coordinate validation are all in place. Manager-only actions gate on `isManager`.

## Pure logic + tests

`lib/location/overview.ts` (projection, history grouping, alerts, battery/since
labels) + `lib/location/geo.ts` (haversine, geofence classification) are unit-tested
in `tests/location-overview.test.ts` (7 tests).

## Seeding demo data

`supabase/seed_location_one_family.sql` seeds **500 `location_events`** + 6
`family_places` + one `member_locations` per member for the target family, covering
every event type, geofence on/off, this-day + trailing-3-weeks dates, and per-member
attribution. Idempotent; ensures the `0111` columns + repairs RLS first.

```bash
npm run db:seed:location       # uses $SUPABASE_DB_URL or local default
# or paste supabase/seed_location_one_family.sql into the Supabase SQL editor

supabase db push               # apply migration 0111 first (or run the .sql)
```
