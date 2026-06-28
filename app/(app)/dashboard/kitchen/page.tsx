import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { pantrySummary, expiringSoon } from '@/lib/pantry/logic';
import { coerceNutrition, type Nutrition } from '@/lib/meals/nutrition';
import { computeFoodScore, type FoodScoreInput } from '@/lib/food/score';
import { activeLeftovers, leftoverNudge, type LeftoverLike } from '@/lib/food/leftovers';
import { KitchenDashboard, type KitchenData } from '@/components/modules/kitchen-dashboard';

export const metadata: Metadata = { title: 'Smart Kitchen | Bubaly' };
export const dynamic = 'force-dynamic';

function mondayOf(d: Date): string {
  const c = new Date(d);
  const day = (c.getDay() + 6) % 7; // 0=Mon
  c.setDate(c.getDate() - day);
  return c.toISOString().slice(0, 10);
}

export default async function KitchenPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const weekStart = mondayOf(now);
  const weekEnd = new Date(new Date(weekStart).getTime() + 6 * 86400000).toISOString().slice(0, 10);

  const [planRes, pantryRes, leftoverRes, recipesRes, groceryRes, nutritionRes] = await Promise.all([
    supabase.from('meal_plans')
      .select('plan_date, meal_type, meals(name)')
      .eq('family_id', familyId).gte('plan_date', weekStart).lte('plan_date', weekEnd).order('plan_date'),
    supabase.from('pantry_items').select('name, expires_at, quantity, low_threshold, is_staple, location').eq('family_id', familyId).limit(300),
    supabase.from('leftover_inventory').select('id, name, source_meal, quantity, use_by, location, status').eq('family_id', familyId).limit(50),
    supabase.from('family_recipes').select('name, rating, estimated_cost_cents').eq('family_id', familyId).limit(300),
    supabase.from('grocery_items').select('id, name, is_checked').eq('family_id', familyId).eq('is_checked', false).limit(200),
    supabase.from('meal_nutrition').select('subject_id, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg')
      .eq('family_id', familyId).eq('subject_type', 'week').eq('subject_id', weekStart).maybeSingle(),
  ]);

  // ── Meal plan rows → tonight + upcoming + variety ──
  type PlanRow = { plan_date: string; meal_type: string; meals: { name: string } | { name: string }[] | null };
  const plans = (planRes.data ?? []) as unknown as PlanRow[];
  const dishName = (r: PlanRow): string => {
    const m = r.meals;
    if (!m) return '';
    return Array.isArray(m) ? (m[0]?.name ?? '') : m.name;
  };

  const dinners = plans.filter((p) => p.meal_type === 'dinner');
  const tonight = dinners.find((p) => p.plan_date === today);
  const upcoming = plans
    .filter((p) => p.plan_date >= today && dishName(p))
    .slice(0, 8)
    .map((p) => ({ date: p.plan_date, mealType: p.meal_type, dish: dishName(p) }));

  const plannedDinnerNames = dinners.map(dishName).filter(Boolean);
  const distinctDishes = new Set(plannedDinnerNames.map((n) => n.toLowerCase())).size;

  // ── Pantry ──
  const pantry = pantryRes.data ?? [];
  const pSummary = pantrySummary(pantry);
  const expiring = expiringSoon(pantry, 5).map((p) => ({ name: p.name, expires_at: p.expires_at ?? null }));

  // ── Leftovers (migration-aware) ──
  const leftoversMissing = isMissingTableError(leftoverRes.error);
  const leftoverRows = (leftoversMissing ? [] : (leftoverRes.data ?? [])) as LeftoverLike[];
  const active = activeLeftovers(leftoverRows);
  const nudge = leftoverNudge(leftoverRows);

  // ── Recipes (rating proxy for satisfaction; cost for budget) ──
  const recipes = recipesRes.data ?? [];
  const rated = recipes.filter((r) => typeof r.rating === 'number' && (r.rating ?? 0) > 0);
  const avgRating = rated.length ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length : null;
  const recipeCostByName = new Map(recipes.filter((r) => r.estimated_cost_cents != null).map((r) => [r.name.toLowerCase(), r.estimated_cost_cents as number]));

  // Estimate planned cost + expiring-usage (lightweight name heuristics).
  const expiringNames = expiring.map((e) => e.name.toLowerCase());
  let plannedCostCents = 0; let costKnown = 0;
  let plannedUsingExpiring = 0;
  for (const name of plannedDinnerNames) {
    const c = recipeCostByName.get(name.toLowerCase());
    if (c != null) { plannedCostCents += c; costKnown++; }
    if (expiringNames.some((en) => name.toLowerCase().includes(en) || en.includes(name.toLowerCase().split(' ')[0]))) {
      plannedUsingExpiring++;
    }
  }

  // ── Nutrition (week cache, if present) ──
  let perDayNutrition: Nutrition | null = null;
  if (!isMissingTableError(nutritionRes.error) && nutritionRes.data && nutritionRes.data.calories != null) {
    perDayNutrition = coerceNutrition(nutritionRes.data);
  }

  // ── Food Score ──
  const scoreInput: FoodScoreInput = {
    plannedSlots: plannedDinnerNames.length,
    totalSlots: 7,
    distinctDishes,
    perDayNutrition,
    pantryTotal: pSummary.total,
    pantryExpired: pSummary.expired,
    pantryExpiringSoon: pSummary.expiringSoon,
    plannedUsingExpiring: Math.min(plannedUsingExpiring, pSummary.expiringSoon),
    plannedCostCents: costKnown > 0 ? plannedCostCents : null,
    weeklyBudgetCents: null, // no household food budget table yet — sub-score skipped
    avgRating,
  };
  const foodScore = computeFoodScore(scoreInput);

  const data: KitchenData = {
    tonight: tonight ? dishName(tonight) : null,
    upcoming,
    pantrySummary: { total: pSummary.total, expiringSoon: pSummary.expiringSoon, expired: pSummary.expired, lowStock: pSummary.lowStock },
    expiring: expiring.slice(0, 6),
    leftovers: active.map((l) => ({
      id: String(l.id), name: l.name ?? '', sourceMeal: l.source_meal ?? null,
      useBy: l.use_by ?? null, location: l.location ?? 'fridge',
    })),
    leftoverNudge: nudge,
    leftoversMissing,
    groceryOpen: (groceryRes.data ?? []).length,
    recipeCount: recipes.length,
    foodScore,
  };

  return <KitchenDashboard data={data} />;
}
