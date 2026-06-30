# `/dashboard/planning` — Planning & Organization hub

A category hub matching the "Planning & Organization" showcase: a header + intro
banner + a responsive **8-card grid**. Each card is **live-wired to Supabase**
(real counts + recent items, no mock data) and links to the full working page.

## Files
| File | Role |
|---|---|
| `app/(app)/dashboard/planning/page.tsx` | Server component, `force-dynamic`: one parallel batch of 8 family-scoped reads → the card grid. |
| `app/(app)/dashboard/planning/layout.tsx` | Wraps `<AppFrame>` for the standard chrome. |
| `lib/constants/navigation.ts` | Adds **Planning** to `PRIMARY_NAV` (after Home). |
| `supabase/seed_planning.sql` | 500-row seed for the planning-specific tables. |

## The 8 cards → table + destination
| Card | Table (read) | Opens |
|---|---|---|
| Calendar | `calendar_events` (upcoming) | `/dashboard/calendar` |
| Tasks | `todo_items` (open) | `/dashboard/todos` |
| Reminders | `family_reminders` (active) | `/dashboard/reminders` |
| Notes | `notes` (recent) | `/dashboard/notes` |
| Documents | `documents` (recent) | `/dashboard/documents` |
| Contacts | `family_contacts` | `/dashboard/contacts` |
| Milestones | `family_milestones` (upcoming) | `/dashboard/celebrations` |
| Family Wall | `family_photos` (recent thumbnails) | `/dashboard/social-feed` |

All reads are scoped to the signed-in user's active `family_id`; RLS on each
table already enforces family membership. **No migration needed** — every table
exists. Empty tables render calm empty states (the page never errors).

## Seed: `supabase/seed_planning.sql` (500 rows)
Fills the four planning-specific tables `seed_home.sql` doesn't:
`notes` (120), `documents` (120), `family_contacts` (130), `family_milestones`
(130) for the 5 demo families. Covers pinned/unpinned + null-title notes & long
bodies; documents with future/past/null expiry & varied categories/mime types;
emergency & normal contacts across every allowed `category` with birthdays;
past (completed) + upcoming milestones. Idempotent + pooler-safe; scoped to the
5 demo family ids (never touches real data).

### Run
```bash
# planning tables only need seed.sql first; for a fully populated hub also run seed_home
npm run seed:planning
# = psql "$DATABASE_URL" -f supabase/seed.sql -f supabase/seed_home.sql -f supabase/seed_planning.sql
```
Point `$DATABASE_URL` at a local/dev DB. If your DB predates some enum values,
run migration `0103_enum_backfill.sql` (or its ALTER TYPE block) once first.

## Local QA checklist
1. `npm run seed:planning` against a dev DB.
2. Sign in as a demo-family member; open `/dashboard/planning` (or the **Planning**
   sidebar entry).
3. Each of the 8 cards shows live preview rows + a count, and "Open" links to the
   real page.
4. A family with no data shows per-card empty hints (no errors).
5. Responsive: 1 col (mobile) → 2 (sm) → 4 (xl).

## Known limitations
- The hub is read-only (previews + navigation); create/edit/delete live on each
  destination page, which are already Supabase-wired.
- "Family Wall" previews recent `family_photos`; there is no dedicated family-wall
  posts table, so it links to the social feed.
