# Chores — data model & wiring

The `/dashboard/chores` page (`components/modules/chores-module.tsx`) is a gamified,
kid-friendly chore board. **Every value on the page is read from Supabase** — there
is no mock/static data. This doc explains where each visual element comes from.

## Tables

| Table | Role |
| --- | --- |
| `chores` | Chore definitions: `title`, `description`, `points`, `priority`, `recurrence` (`daily`/`weekly`/`monthly`/…), `icon` (emoji), `requires_approval`, `cash_cents` (optional wallet payout). |
| `chore_assignments` | One row per (chore → member). Tracks `status` (`todo`→`in_progress`→`submitted`→`approved`/`done`, plus `rejected`), `due_at`, `submitted_at`, `approved_at`, `approved_by`, `points_awarded`, `cash_awarded_cents`. |
| `family_members` | The children/adults shown as filter pills, assignees, earners and streaks. |
| `rewards` | The Chore Store + Rewards Progress goal (`title`, `cost_points`, `redeemed_at`). |
| `reward_redemptions` | Created when a member redeems a reward from the store. |

All five have family-scoped RLS (`public.is_family_member(family_id)`) for
SELECT/INSERT/UPDATE/DELETE (migrations `0004_rls.sql`, repaired in the seed).

## Where each UI element comes from

- **Daily / Weekly / Other tables** — active (non-completed) `chore_assignments`
  grouped by their chore's `recurrence` (`groupByRecurrence`).
- **Completed Chores** — assignments with status `approved`/`done`.
- **Child filter pills** — `family_members`; the per-child point count is the sum of
  `points_awarded` over that member's completed assignments (`pointsByMember`).
- **Family Chore Points** — `totalFamilyPoints`, filtered by the This Week / This
  Month / All Time window (on `approved_at`).
- **Top Earners** — `topEarners` (members ranked by points, medals for the top 3).
- **Chore Streaks** — `streaksByMember`: consecutive-day completion streaks derived
  from each member's `approved_at` days (only "live" streaks — latest completion
  today or yesterday — are shown).
- **Rewards Progress** — `rewardsProgress`: the top earner's progress toward the
  cheapest `rewards` row they can't yet afford.
- **Need Approval / Approvals tab** — assignments with status `submitted`.
- **Chore Store tab** — `rewards`; redeeming inserts a `reward_redemptions` row
  (auto-approved for managers, otherwise `requested`).

## Interactions (all persisted)

| Action | Effect |
| --- | --- |
| Add Chore / Chore Templates | Inserts `chores` + `chore_assignments` (rolls back the chore if the assignment insert fails). |
| Status pill / kebab → Start, Submit | Updates `chore_assignments.status` (+ `submitted_at`). |
| Approve / Review | Sets `status='approved'`, `approved_at`, `approved_by`, `points_awarded`. |
| Pay `$` (kebab) | `payChoreRewardAction` — pays the chore's `cash_cents` to the member's wallet. |
| Delete | Deletes the `chore_assignments` row. |
| Redeem (store) | Inserts `reward_redemptions`. |
| Add Child | Navigates to `/dashboard/settings#members` (member management). |

## Pure logic + tests

Aggregation is isolated in `lib/chores/dashboard.ts` (points, leaderboard, streaks,
recurrence grouping, reward progress, due labels, emoji resolution) and unit-tested
in `tests/chores-dashboard.test.ts` (16 tests). The component only wires these pure
transforms to already-fetched rows.

## Seeding demo data

`supabase/seed_chores_one_family.sql` seeds **500 `chore_assignments`** (plus a ~30
chore catalog and a reward catalog) for the target family, covering every status,
recurrence, due-date bucket and approval state. It is idempotent (seeded chores are
tagged `instructions = '[seed:chores]'` and replaced on re-run) and repairs RLS
first so the rows are readable.

```bash
npm run db:seed:chores          # uses $SUPABASE_DB_URL or local default
# or paste supabase/seed_chores_one_family.sql into the Supabase SQL editor
```
