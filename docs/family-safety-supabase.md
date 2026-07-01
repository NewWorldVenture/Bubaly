# Family safety pages + expandable nav

The left sidebar's **Family** entry is now an **expandable group** (chevron
toggles a nested list; the row still links to `/dashboard/family`). Its children
link to four new, fully Supabase-wired pages.

## Expandable nav

- `NavItem` gained an optional `children?: NavItem[]` (`lib/constants/navigation.ts`).
- `components/app/nav-shared.tsx` renders any list item with `children` via
  `ExpandableNavEntry`: the parent navigates to its own page and a chevron
  toggles the nested destinations. Auto-expands when you're on the parent or any
  child route; active child is highlighted. Works in both sidebars and the
  mobile drawer.
- `PRIMARY_NAV.Family.children` = Check In, Find Phone, Driving Safety, Play Dates.

## Pages & components

| Route | Component | Table |
| --- | --- | --- |
| `/dashboard/family/check-in` | `components/family/check-in-view.tsx` | `safety_check_ins` |
| `/dashboard/family/find-phone` | `components/family/find-phone-view.tsx` | `member_locations` + `family_places` (reused) |
| `/dashboard/family/driving-safety` | `components/family/driving-safety-view.tsx` | `driving_trips` |
| `/dashboard/family/play-dates` | `components/family/play-dates-view.tsx` | `play_dates` |

Pure, tested helpers: `lib/family/safety.ts` (driving score, status metadata,
play-date split, formatting) — `tests/family-safety.test.ts`.

## Supabase (migration 0114_family_safety.sql)

New family-scoped tables with RLS (SELECT/INSERT/UPDATE/DELETE via
`is_family_member`), indexes, and `updated_at` triggers:
- `safety_check_ins` — status (safe/on_my_way/arrived/need_help), place, note,
  optional lat/lng.
- `driving_trips` — per-driver trip with distance, max_mph, hard_brakes,
  rapid_accels, phone_use_seconds, and a 0–100 `score`.
- `play_dates` — kids' play-date scheduling (child, with, location, starts_at,
  status, contact, notes).

Find Phone reuses the existing location tables (no new schema) — read-only
last-known location per member, battery, sharing status, "Open in Maps".

## What's wired

Read (realtime) + create + status changes + delete on all three new tables,
scoped to the active family via RLS. Loading skeletons, empty states, toasts,
confirms on destructive actions, `tel:`/Maps deep links. Check In can attach the
device's geolocation (with permission). Driving score is computed deterministically
(`drivingScore`) and previewed live in the log-trip form.

## Migration & seed

```bash
npm run db:push          # apply migration 0114
npm run db:seed:family   # ~150 rows: 60 check-ins, 60 trips, 30 play dates
```

The seed is idempotent (rows tagged `[seed]`), covers every status/score band,
and spans past + upcoming dates. Validated on a throwaway PG16.

## Notes / limitations

- Find Phone can't actively "ring" a device (no push-to-ring backend); it shows
  the last-known location reported by each member's device and links to the
  Family Map for live sharing.
- Driving trips are logged manually (or by an integration later); there's no
  automatic on-device trip detection yet.
