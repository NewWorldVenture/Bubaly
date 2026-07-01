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
  rating and optional link. Realtime, filter chips, empty/loading states.
- **Nutrition Tracker** — `components/meals/nutrition-view.tsx` → `nutrition_logs`.
  Per-member day view with calorie + macro + water totals (`dailyTotals`),
  entries grouped by meal, log/delete. Member tabs.

Pure tested helpers: `lib/meals/tracker.ts` (`dailyTotals`, `groupByMeal`,
metadata) — `tests/meals-tracker.test.ts`.

## Supabase (migration 0115_meals_hub.sql)

New family-scoped tables with RLS (SELECT/INSERT/UPDATE/DELETE via
`is_family_member`), indexes, and `updated_at` triggers:
- `family_favorites` — kind, name, notes, rating, ref_url, member_id.
- `nutrition_logs` — member_id, logged_on, meal, item, calories, protein/carbs/
  fat (g), water_ml.

## Migration & seed

```bash
npm run db:push        # apply migration 0115
npm run db:seed:meals  # ~24 favorites + ~130 nutrition logs (idempotent)
```

Validated on a throwaway PG16. No new environment variables.
