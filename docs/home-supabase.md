# `/home` dashboard — Supabase wiring & seed

The family Home at **`/home`** is the default post-login landing (everyone except
super-admins) and the Home-button target. It is a server component that reads
**live Supabase data** — no mock/static content.

## Files

| File | Role |
|---|---|
| `app/(app)/home/page.tsx` | Server component: one parallel batch of family-scoped Supabase reads → the widget grid. `force-dynamic`. |
| `app/(app)/home/layout.tsx` | Wraps `<AppFrame>` so `/home` inherits the sidebar / top-bar / mobile-nav chrome. |
| `lib/home/family-score.ts` | Pure: 0–100 Family Score from chore completion + overdue tasks/reminders. |
| `lib/home/home-data.ts` | Pure: `summarizeMonthFinances`, `usd`, `memberTagline`, `ageFromBirthday`, `weekStrip`, `isoDate`. |
| `tests/home-dashboard.test.ts` | 14 unit tests for the pure helpers. |
| `supabase/seed_home.sql` | ~665-row demo seed for every widget (below). |

## Supabase tables read by the page

All scoped to the signed-in user's active `family_id` (RLS already enforces
family membership on each — no new policies needed; this is read-only against
existing, policy-covered tables):

`family_members`, `calendar_events`, `todo_items`, `chore_assignments` + `chores`,
`meal_plans` + `meals`, `transactions`, `family_photos`, `family_messages`,
`family_reminders` (overdue → Family Score + "needs you").

No migration was required — every table already exists with RLS, indexes, and
`updated_at` triggers from earlier migrations (`0002`, `0014`, `0015`, `0102`, …).
Reads tolerate empty tables (`?? []`), so the page degrades to polished empty
states rather than erroring.

## Seed: `supabase/seed_home.sql` (~665 rows)

Populates **every `/home` widget** with NOW()-relative data for the 5 demo
families from `seed.sql`, so Today's Schedule, Tasks, Upcoming Events, What's for
Dinner, Chores, Family Finances, Recent Memories, Family Messages, and the
Family Score / "Needs you" signals all render full.

Covers the required states: today / overdue / upcoming / null due dates, completed
vs open tasks, approved vs todo chores, this-month income & expenses, overdue &
completed reminders, long titles (wrapping), and missing optional fields.

**Idempotent + pooler-safe**: no temp tables / no `BEGIN-COMMIT`; every statement
is scoped to the 5 demo family ids **and** to rows this file created (tagged via
`external_uid 'seedhome:%'`, `notes='seedhome'`, `chores.category='home_demo'`,
album/conversation names `… (demo)`), so re-runs clear and re-insert their own
rows only. Safe even if pointed at a populated DB — real families are never
matched, so it **never seeds production data**.

### Run it locally

Requires DB access (the file can't reach your project on its own). Run `seed.sql`
first (creates the 5 families + 25 members), then `seed_home.sql`:

```bash
# wrapper script (needs $DATABASE_URL pointing at your local/dev DB)
npm run seed:home

# or explicitly
psql "$DATABASE_URL" -f supabase/seed.sql -f supabase/seed_home.sql

# or paste both files into the Supabase SQL Editor (seed.sql first)
```

> ⚠️ Point `$DATABASE_URL` at a **local/dev** database. Never run seeds against
> production.

## Local QA checklist

1. Sign in as a member of a demo family (or set your active family to a demo id).
2. Visit `/home` (also reachable via the Home button / after login).
3. Verify each widget renders populated:
   - **My Family** — member avatars + taglines (Me / age / role).
   - **Family Score** — ring 0–100 + message.
   - **Today's Schedule** — today's timed events.
   - **Tasks** — open to-dos with due chips + assignee.
   - **Upcoming Events** — next ~30d with date chips.
   - **What's for Dinner** — today's dinner (Tuscan Chicken Pasta) + Mon–Sun strip.
   - **Chores** — assignments with done/▢ + member.
   - **Family Finances** — income/expenses/remaining donut for this month.
   - **Recent Memories** — 4 photo thumbnails.
   - **Family Messages** — recent messages with names + times.
4. Empty state: a family with no data shows calm "nothing yet" rows (not errors).
5. Responsive: collapses to 1 column on mobile; chrome via `AppFrame` drawer.

## Environment

Uses the existing Supabase env (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, server `SUPABASE_SERVICE_ROLE_KEY` for plan
resolution only). No new env vars.

## Known limitations

- Seeded `family_messages` have `sender_id = NULL` (demo members are managed
  profiles with no `auth.users` row), so the unread dot doesn't show for seeded
  messages — it works for real messages from real users.
- The seed must be run manually against a DB you control; there is no local
  Supabase instance in CI.
