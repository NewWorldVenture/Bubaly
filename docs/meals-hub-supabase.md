# Meals hub — expandable nav + Favorites/Nutrition pages

The sidebar's **Meals** entry is now an expandable group (same mechanism as
Family — `NavItem.children` + `ExpandableNavEntry`). It links to seven
destinations; five already existed and two are new:

| Child | Route | Status |
| --- | --- | --- |
| Meal Planner | `/dashboard/meals` | existing |
| Recipes | `/dashboard/recipes` | existing |
| Grocery List | `/dashboard/grocery` | existing |
| Pantry Inventory | `/dashboard/pantry` | existing |
| Family Favorites | `/dashboard/favorites` | **new** |
| Nutrition Tracker | `/dashboard/nutrition` | **new** |
| Dining Out | `/dashboard/dining` | existing |

## New pages

- **Family Favorites** — `components/meals/favorites-view.tsx` → `family_favorites`.
  Add/filter/delete favorite recipes, restaurants, meals, snacks, drinks with a
  rating and optional link. Filter chips, empty/loading states. Not realtime:
  `family_favorites` is not in the realtime publication (`REALTIME_TABLES` in
  `lib/realtime/published-tables.ts`), so the view re-reads the list after each
  of its own confirmed writes and another device sees a change on its next load.
- **Nutrition Tracker** — `components/meals/nutrition-view.tsx` → `nutrition_logs`.
  Per-member day view with calorie + macro + water totals (`dailyTotals`),
  entries grouped by meal, log/delete. Member tabs. Not realtime either
  (`nutrition_logs` is not published); same read-back after each write.

Pure tested helpers: `lib/meals/tracker.ts` (`dailyTotals`, `groupByMeal`,
metadata) — `tests/meals-tracker.test.ts`.

## Supabase (migration 0115_meals_hub.sql)

New family-scoped tables with RLS (SELECT/INSERT/UPDATE/DELETE via
`is_family_member`), indexes, and `updated_at` triggers. A later migration,
`0430_a_health_record_is_not_a_siblings_to_rewrite.sql`, narrowed UPDATE/DELETE
on `nutrition_logs` to a manager, the row's author, or the member the row is
about; SELECT and INSERT there, and all four on `family_favorites`, are still
any family member:
- `family_favorites` — kind, name, notes, rating, ref_url, member_id.
- `nutrition_logs` — member_id, logged_on, meal, item, calories, protein/carbs/
  fat (g), water_ml.

## Migration & seed

```bash
npm run db:push        # pushes every pending migration (0115 included) to the LINKED project
npm run db:seed:meals  # ~24 favorites + ~130 nutrition logs (idempotent)
```

`db:seed:meals` runs `supabase/seed_meals_extras_one_family.sql` against
`$SUPABASE_DB_URL`, or the local Supabase database when that is unset. It seeds
one family, prints `Seed skipped` and writes nothing unless the anchor account
named in that file exists, and on a re-run replaces only rows tagged
`notes='[seed]'`.

Validated on a throwaway PG16. No new environment variables.
