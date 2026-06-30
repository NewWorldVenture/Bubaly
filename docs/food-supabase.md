# `/dashboard/food` — Food & Nutrition hub (+ Dining Out)

Recreates the "Food & Nutrition" showcase: header + intro banner + a responsive
**7-card grid** + a features panel. Each card is **live-wired to Supabase** and
links to the real page. The one surface without prior infrastructure — **Dining
Out** — gets a new table + route.

## Pages / files
| File | Role |
|---|---|
| `app/(app)/dashboard/food/page.tsx` | Hub (server, `force-dynamic`): one parallel batch of 7 family-scoped reads → card grid + features panel. |
| `app/(app)/dashboard/food/layout.tsx` | Wraps `<AppFrame>`. |
| `app/(app)/dashboard/dining/{page,layout}.tsx` | **New** Dining Out page: Recommended restaurants + Recent dining-out visits. |
| `lib/constants/navigation.ts` | Adds **Food** to `PRIMARY_NAV`. |
| `supabase/migrations/0104_dining_out.sql` | **New** `dining_out` table + indexes + `set_updated_at` trigger + RLS. |
| `lib/database.types.ts` | Adds the `dining_out` row/insert/update types. |
| `supabase/seed_food.sql` | 520-row seed (recipes / pantry / dining). |

## The 7 cards → table + destination
| Card | Table (read) | Opens |
|---|---|---|
| Meal Planner | `meal_plans` (+`meals`) this week | `/dashboard/meals` |
| Recipes | `family_recipes` (recent) | `/dashboard/recipes` |
| Grocery List | `grocery_items` (unchecked) | `/dashboard/grocery` |
| Pantry Inventory | `pantry_items` (expiring) | `/dashboard/pantry` |
| Family Favorites | `family_recipes` (is_favorite) | `/dashboard/recipes` |
| Nutrition Tracker | `family_food_scores` (latest) | `/dashboard/kitchen` |
| Dining Out | `dining_out` | `/dashboard/dining` |

All reads are family-scoped; RLS on each table enforces membership. Queries are
tolerant of an un-migrated `dining_out` (`?? []`), so the hub/Dining-Out page show
empty states rather than erroring before `0104` is applied.

## Schema — `dining_out` (migration `0104`)
`id, family_id→families, name, kind('restaurant'|'visit'), cuisine, category,
price_level(1–4), rating(0–5), address, distance_km, amount_cents, item_count,
notes, is_favorite, visited_at, metadata, created_by, created_at, updated_at`.
Indexes on `family_id`, `(family_id,kind)`, `(family_id,visited_at)`,
`(family_id,is_favorite)`. `set_updated_at` trigger. **RLS**: `Members can manage
dining_out` FOR ALL using/with check `is_family_member(family_id)` — mirrors the
food-OS tables; no public/anon access. Run with `supabase db push` (or paste the
migration into the SQL Editor).

## Seed — `supabase/seed_food.sql` (520 rows)
`family_recipes` (250), `pantry_items` (150), `dining_out` (120) for the 5 demo
families. Covers every recipe category + difficulty, favorites + ratings (incl.
null), pantry items expiring soon/future/past/null across all storage locations
+ staples/low-stock, and dining restaurants (rated/priced/favorited) + logged
visits (spend + items + dates). Idempotent, pooler-safe, scoped to demo ids.

### Run
```bash
npm run seed:food
# = psql "$DATABASE_URL" -f supabase/seed.sql -f supabase/seed_home.sql -f supabase/seed_food.sql
```
Apply migrations first (`supabase db push`) so `dining_out` exists. If the DB
predates some enum values, run `0103_enum_backfill.sql` once.

## Local QA checklist
1. Apply migrations (≥ `0104`), then `npm run seed:food` against a dev DB.
2. Open `/dashboard/food` (or the **Food** sidebar entry): all 7 cards show live
   data + counts; the features panel renders; "Open" links navigate.
3. Open `/dashboard/dining`: Recommended restaurants + Recent visits populate.
4. A family with no data shows calm empty states (no errors).
5. Responsive: 1 → 2 (sm) → 4 (xl) columns; features panel spans full width.

## Known limitations
- The hub is read-only previews + navigation; create/edit/delete live on each
  destination page (Meals/Recipes/Grocery/Pantry already Supabase-wired). Dining
  Out is read-only for now (seeded data); add-flow is a future increment.
- Nutrition Tracker previews the latest `family_food_scores` snapshot and links to
  Smart Kitchen (the food-OS surface); there is no standalone nutrition route.
