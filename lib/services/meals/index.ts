// Meal plans, the meal library, recipes and the household food profile.
//
// THE TABLES, from the migrations rather than from memory:
//   `meals` (0002)         — the dish library; `ingredients` jsonb `[{name, qty, unit}]`;
//                            `created_by` → auth.users.
//   `meal_plans` (0002)    — one row per (plan_date, meal_type) slot pointing
//                            at a `meals` row; `created_by` → auth.users.
//   `family_recipes` (0014) — full recipes; `ingredients` jsonb
//                            `[{name, quantity, unit}]`, `created_by` → auth.users.
//   `family_favorites` (0115) — per-member favourites, `kind` recipe|meal|…
//   `medical_profiles` (0009) — `allergies` free text per member.
//   `family_facts` (0123)   — `category='preference'` rows hold food likes,
//                            dislikes and diets ("Tom doesn't eat mushrooms").
//
// WHY `planWeek` snapshots before it clears: the existing planner route
// (`app/api/ai/meals/plan/route.ts`) learned the hard way that a plan write is
// three dependent writes — create any missing dishes, clear the targeted
// slots, insert the new rows — and a failure in the third leaves a family
// with an empty week. The rollback here restores the previous slots and
// removes the dishes this call created, so a failed replan is a no-op rather
// than a wipe. Slots are cleared per (meal_type → dates) group, never as a
// dates × types rectangle, so planning Monday dinner and Wednesday lunch does
// not silently remove Monday lunch.
//
// The food profile reads allergies from the medical profile but deliberately
// exposes ONLY the allergy terms — no conditions, medications or contacts —
// because that is the single medical fact a meal planner must know and the
// rest is none of its business.
import 'server-only';
import type { Json, MealType, Tables } from '@/lib/database.types';
import { normalizeAllergies } from '@/lib/meals/pantry-chef';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { getMembers } from '../family';
import { withIdempotency } from '../idempotency';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type Meal = Tables<'meals'>;
export type MealPlanRow = Tables<'meal_plans'>;
export type Recipe = Tables<'family_recipes'>;

export const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const RECIPE_CATEGORIES = ['breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'drink', 'side', 'appetizer', 'other'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MEALS_HREF = '/dashboard/meals';

/** A normalised ingredient line, whichever of the two jsonb dialects it came from. */
export type Ingredient = { name: string; quantity: string | null; unit: string | null };

function isMealType(value: unknown): value is MealType {
  return typeof value === 'string' && (MEAL_TYPES as string[]).includes(value);
}

/** Real calendar day check: `2026-02-30` matches the regex but is not a date. */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_KEY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * The seven day keys starting at `weekStart`, computed in UTC arithmetic so a
 * server running in any zone produces the same keys — `lib/meals/planner.ts
 * weekDates` uses local `Date` math and drifts a day west of Greenwich.
 */
export function weekDayKeys(weekStart: string): string[] {
  const base = Date.parse(`${weekStart}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => new Date(base + i * 86_400_000).toISOString().slice(0, 10));
}

/** Case, spacing and a trailing plural are not differences between two dish names. */
export function normalizeDishName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Read either ingredient dialect — `meals.ingredients` uses `qty`, the recipe
 * module uses `quantity` — into one shape. Anything that is not an object with
 * a name is dropped rather than rendered as "undefined".
 */
export function parseIngredients(raw: Json | null | undefined): Ingredient[] {
  if (!Array.isArray(raw)) return [];
  const out: Ingredient[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const name = entry.trim();
      if (name) out.push({ name, quantity: null, unit: null });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, Json | undefined>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    const qtyRaw = record.quantity ?? record.qty;
    const quantity = typeof qtyRaw === 'number' ? String(qtyRaw) : typeof qtyRaw === 'string' && qtyRaw.trim() ? qtyRaw.trim() : null;
    const unit = typeof record.unit === 'string' && record.unit.trim() ? record.unit.trim() : null;
    out.push({ name, quantity, unit });
  }
  return out;
}

function ingredientsToJson(list: Ingredient[] | undefined): Json {
  return (list ?? []).map((i) => ({ name: i.name, qty: i.quantity, unit: i.unit }));
}

// ── Meal library ────────────────────────────────────────────────────────────

/**
 * Find a dish by name (case-insensitive, family-scoped) or create it.
 *
 * Reuse by name is what keeps the library from filling with "Tacos", "tacos"
 * and "Tacos " every time the planner runs; the legacy `create_meal_plan_entry`
 * action inserted a new `meals` row on every call and families noticed.
 */
export async function ensureMealByName(
  scope: ServiceScope,
  input: { name: string; mealType?: MealType | null; ingredients?: Ingredient[]; recipeUrl?: string | null },
): Promise<ServiceResult<{ meal: Meal; created: boolean }>> {
  const name = input.name?.trim() ?? '';
  if (!name) return fail('A meal needs a name.', { code: SERVICE_CODES.invalidInput });
  const mealType = isMealType(input.mealType) ? input.mealType : 'dinner';

  const term = name.replace(/[%_]/g, (m) => `\\${m}`);
  const { data: existing, error: lookupError } = await scope.db
    .from('meals')
    .select('*')
    .eq('family_id', scope.familyId)
    .ilike('name', term)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (lookupError) {
    console.error('[service:meals] meal lookup failed', lookupError);
    return fail(describeDbError(lookupError, 'Could not look up that meal.'), { code: SERVICE_CODES.db });
  }
  if (existing) return ok({ meal: existing, created: false });

  const { data, error } = await scope.db
    .from('meals')
    .insert({
      family_id: scope.familyId,
      name,
      meal_type: mealType,
      ingredients: ingredientsToJson(input.ingredients),
      recipe_url: input.recipeUrl?.trim() || null,
      // meals.created_by references auth.users (0002).
      created_by: scope.userId,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:meals] meal create failed', error);
    return fail(describeDbError(error, 'Could not save that meal.'), { code: SERVICE_CODES.db });
  }
  return ok({ meal: data, created: true });
}

// ── Meal plan ───────────────────────────────────────────────────────────────

export type PlanSlot = {
  id: string;
  date: string;
  mealType: MealType;
  mealId: string | null;
  name: string | null;
  ingredients: Ingredient[];
};

export type WeekPlan = { weekStart: string; dates: string[]; slots: PlanSlot[] };

/** Every planned slot in a Monday-to-Sunday week, oldest date first. */
export async function getMealPlan(scope: ServiceScope, weekStart: string): Promise<ServiceResult<WeekPlan>> {
  if (!isDayKey(weekStart)) return fail('A week start must look like 2026-09-07.', { code: SERVICE_CODES.invalidInput });
  const dates = weekDayKeys(weekStart);
  const plans = await loadSlots(scope, dates);
  if (!plans.ok) return plans;
  return ok({ weekStart, dates, slots: plans.data });
}

async function loadSlots(scope: ServiceScope, dates: string[]): Promise<ServiceResult<PlanSlot[]>> {
  const { data: rows, error } = await scope.db
    .from('meal_plans')
    .select('*')
    .eq('family_id', scope.familyId)
    .in('plan_date', dates)
    .order('plan_date', { ascending: true });
  if (error) {
    console.error('[service:meals] plan read failed', error);
    return fail(describeDbError(error, 'Could not read the meal plan.'), { code: SERVICE_CODES.db });
  }
  const planRows = rows ?? [];
  const mealIds = [...new Set(planRows.map((r) => r.meal_id).filter((id): id is string => Boolean(id)))];
  const meals = new Map<string, Meal>();
  if (mealIds.length) {
    const { data: mealRows, error: mealError } = await scope.db
      .from('meals')
      .select('*')
      .eq('family_id', scope.familyId)
      .in('id', mealIds);
    if (mealError) {
      console.error('[service:meals] meal read failed', mealError);
      return fail(describeDbError(mealError, 'Could not read the meal plan.'), { code: SERVICE_CODES.db });
    }
    for (const meal of mealRows ?? []) meals.set(meal.id, meal);
  }
  const order = new Map(MEAL_TYPES.map((t, i) => [t, i]));
  const slots = planRows.map((row): PlanSlot => {
    const meal = row.meal_id ? meals.get(row.meal_id) ?? null : null;
    return {
      id: row.id,
      date: row.plan_date,
      mealType: row.meal_type,
      mealId: row.meal_id,
      name: meal?.name ?? null,
      ingredients: parseIngredients(meal?.ingredients),
    };
  });
  slots.sort((a, b) => a.date.localeCompare(b.date) || (order.get(a.mealType) ?? 9) - (order.get(b.mealType) ?? 9));
  return ok(slots);
}

export type PlanEntryInput = {
  /** `YYYY-MM-DD` */
  date: string;
  mealType?: MealType | null;
  /** Either an existing `meals.id`… */
  mealId?: string | null;
  /** …or a dish name, reused from the library when it already exists. */
  mealName?: string | null;
  ingredients?: Ingredient[];
};

type ResolvedEntry = { date: string; mealType: MealType; mealId: string; name: string };

/**
 * Turn each entry into a concrete `meals.id`, creating dishes as needed and
 * remembering which ones were created so a later failure can remove them.
 */
async function resolveEntries(
  scope: ServiceScope,
  entries: PlanEntryInput[],
  createdMealIds: string[],
): Promise<ServiceResult<ResolvedEntry[]>> {
  const resolved: ResolvedEntry[] = [];
  const byName = new Map<string, Meal>();
  for (const entry of entries) {
    const mealType = isMealType(entry.mealType) ? entry.mealType : 'dinner';
    if (entry.mealId) {
      const { data, error } = await scope.db
        .from('meals')
        .select('*')
        .eq('family_id', scope.familyId)
        .eq('id', entry.mealId)
        .maybeSingle();
      if (error) {
        console.error('[service:meals] meal read failed', error);
        return fail(describeDbError(error, 'Could not read that meal.'), { code: SERVICE_CODES.db });
      }
      if (!data) return fail('That meal could not be found.', { code: SERVICE_CODES.notFound });
      resolved.push({ date: entry.date, mealType, mealId: data.id, name: data.name });
      continue;
    }
    const name = entry.mealName?.trim() ?? '';
    const key = normalizeDishName(name);
    const cached = byName.get(key);
    if (cached) {
      resolved.push({ date: entry.date, mealType, mealId: cached.id, name: cached.name });
      continue;
    }
    const ensured = await ensureMealByName(scope, { name, mealType, ingredients: entry.ingredients });
    if (!ensured.ok) return ensured;
    if (ensured.data.created) createdMealIds.push(ensured.data.meal.id);
    byName.set(key, ensured.data.meal);
    resolved.push({ date: entry.date, mealType, mealId: ensured.data.meal.id, name: ensured.data.meal.name });
  }
  return ok(resolved);
}

function validateEntries(entries: PlanEntryInput[]): ServiceResult<PlanEntryInput[]> {
  if (!Array.isArray(entries) || entries.length === 0) return fail('There was nothing to plan.', { code: SERVICE_CODES.invalidInput });
  if (entries.length > 40) return fail('That is more than a week of meals — plan at most 40 slots at a time.', { code: SERVICE_CODES.invalidInput });
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isDayKey(entry.date)) return fail(`"${entry.date}" is not a date like 2026-09-07.`, { code: SERVICE_CODES.invalidInput });
    if (entry.mealType != null && !isMealType(entry.mealType)) return fail(`"${entry.mealType}" is not a meal type.`, { code: SERVICE_CODES.invalidInput });
    if (!entry.mealId && !entry.mealName?.trim()) return fail(`The ${entry.mealType ?? 'dinner'} on ${entry.date} has no dish.`, { code: SERVICE_CODES.invalidInput });
    const slot = `${entry.date}|${entry.mealType ?? 'dinner'}`;
    if (seen.has(slot)) return fail(`The ${entry.mealType ?? 'dinner'} on ${entry.date} was given twice.`, { code: SERVICE_CODES.invalidInput });
    seen.add(slot);
  }
  return ok(entries);
}

/** Group the targeted slots by meal type so each delete hits exactly those slots. */
function slotGroups(entries: { date: string; mealType: MealType }[]): { mealType: MealType; dates: string[] }[] {
  const groups = new Map<MealType, Set<string>>();
  for (const e of entries) {
    const set = groups.get(e.mealType) ?? new Set<string>();
    set.add(e.date);
    groups.set(e.mealType, set);
  }
  return [...groups.entries()].map(([mealType, dates]) => ({ mealType, dates: [...dates] }));
}

export type PlanWeekResult = {
  planned: PlanSlot[];
  /** Slots that held a different dish before this call. */
  replaced: number;
  /** Dishes added to the library because the plan named something new. */
  createdMeals: number;
};

/**
 * Write a set of slots as one unit, replacing whatever those slots held.
 *
 * Failure handling, in order: a dish that cannot be resolved aborts before
 * anything is cleared; a failed clear removes the dishes created so far; a
 * failed insert re-clears the slots, restores the snapshot and removes the
 * created dishes. Each rollback step logs its own failure rather than hiding
 * behind the first one, because a half-restored week is what a person will
 * actually be looking at.
 */
export async function planWeek(scope: ServiceScope, entries: PlanEntryInput[]): Promise<ServiceResult<PlanWeekResult>> {
  const valid = validateEntries(entries);
  if (!valid.ok) return valid;

  const createdMealIds: string[] = [];
  const removeCreatedMeals = async () => {
    if (!createdMealIds.length) return;
    const { error } = await scope.db.from('meals').delete().eq('family_id', scope.familyId).in('id', createdMealIds);
    if (error) console.error('[service:meals] rollback of created meals failed', error);
  };

  const resolved = await resolveEntries(scope, valid.data, createdMealIds);
  if (!resolved.ok) {
    await removeCreatedMeals();
    return resolved;
  }

  const groups = slotGroups(resolved.data);

  // Snapshot what the targeted slots hold today, so they can be put back.
  const snapshot: { family_id: string; meal_id: string | null; plan_date: string; meal_type: MealType; created_by: string | null }[] = [];
  for (const group of groups) {
    const { data, error } = await scope.db
      .from('meal_plans')
      .select('family_id, meal_id, plan_date, meal_type, created_by')
      .eq('family_id', scope.familyId)
      .eq('meal_type', group.mealType)
      .in('plan_date', group.dates);
    if (error) {
      console.error('[service:meals] existing slot read failed', error);
      await removeCreatedMeals();
      return fail(describeDbError(error, 'Could not read the current meal plan.'), { code: SERVICE_CODES.db });
    }
    snapshot.push(...(data ?? []));
  }

  const clearSlots = async (): Promise<unknown> => {
    for (const group of groups) {
      const { error } = await scope.db
        .from('meal_plans')
        .delete()
        .eq('family_id', scope.familyId)
        .eq('meal_type', group.mealType)
        .in('plan_date', group.dates);
      if (error) return error;
    }
    return null;
  };

  const clearError = await clearSlots();
  if (clearError) {
    console.error('[service:meals] slot clear failed', clearError);
    await removeCreatedMeals();
    return fail(describeDbError(clearError, 'Could not update the meal plan.'), { code: SERVICE_CODES.db });
  }

  const rows = resolved.data.map((e) => ({
    family_id: scope.familyId,
    meal_id: e.mealId,
    plan_date: e.date,
    meal_type: e.mealType,
    // meal_plans.created_by references auth.users (0002).
    created_by: scope.userId,
  }));
  const { data: inserted, error: insertError } = await scope.db.from('meal_plans').insert(rows).select('*');
  if (insertError || !inserted || inserted.length !== rows.length) {
    console.error('[service:meals] plan insert failed', insertError ?? new Error('meal plan insert returned an incomplete result'));
    const reclearError = await clearSlots();
    if (reclearError) console.error('[service:meals] rollback clear failed', reclearError);
    if (snapshot.length) {
      const { error: restoreError } = await scope.db.from('meal_plans').insert(snapshot);
      if (restoreError) console.error('[service:meals] rollback restore failed', restoreError);
    }
    await removeCreatedMeals();
    return fail(describeDbError(insertError, 'Could not save the meal plan.'), { code: SERVICE_CODES.db });
  }

  const nameById = new Map(resolved.data.map((e) => [e.mealId, e.name]));
  const planned = inserted.map((row): PlanSlot => ({
    id: row.id,
    date: row.plan_date,
    mealType: row.meal_type,
    mealId: row.meal_id,
    name: row.meal_id ? nameById.get(row.meal_id) ?? null : null,
    ingredients: [],
  }));

  const dates = [...new Set(planned.map((p) => p.date))].sort();
  await recordActivitySafely(scope, {
    agent: 'meal_planner',
    title: planned.length === 1
      ? `Planned ${planned[0].name ?? 'a meal'} for ${planned[0].date}`
      : `Planned ${planned.length} meals from ${dates[0]} to ${dates[dates.length - 1]}`,
    detail: planned.map((p) => `${p.date} ${p.mealType}: ${p.name ?? '—'}`).join('\n'),
    href: MEALS_HREF,
  });

  return ok({ planned, replaced: snapshot.length, createdMeals: createdMealIds.length });
}

/**
 * Put one dish in one slot. This is `planWeek` with a single entry — the
 * legacy `create_meal_plan_entry` shape — kept as its own function so callers
 * that think in slots do not have to build a list.
 */
export async function setSlot(scope: ServiceScope, input: PlanEntryInput): Promise<ServiceResult<PlanSlot & { replaced: boolean }>> {
  const res = await planWeek(scope, [input]);
  if (!res.ok) return res;
  const slot = res.data.planned[0];
  if (!slot) return fail('The meal plan did not record that slot.', { code: SERVICE_CODES.db });
  return ok({ ...slot, replaced: res.data.replaced > 0 });
}

/**
 * Clear one planned meal.
 *
 * Family-scoped, where the module deleted on `id` alone and left tenancy to RLS.
 * The meal itself survives — a plan slot is a placement, not the recipe.
 */
export async function removeSlot(scope: ServiceScope, planId: string): Promise<ServiceResult<{ id: string }>> {
  const { data, error } = await scope.db
    .from('meal_plans')
    .delete()
    .eq('id', planId)
    .eq('family_id', scope.familyId)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[service:meals] remove slot failed', error);
    return fail(describeDbError(error, 'Could not clear that meal.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That planned meal could not be found.', { code: SERVICE_CODES.notFound });
  return ok({ id: data.id });
}

// ── Recipes ─────────────────────────────────────────────────────────────────

export type RecipeSummary = {
  id: string;
  name: string;
  category: string;
  cuisine: string | null;
  servings: number;
  prepTimeMins: number | null;
  cookTimeMins: number | null;
  difficulty: string;
  allergyFlags: string[];
  tags: string[];
  isFavorite: boolean;
  rating: number | null;
  ingredients: Ingredient[];
};

function toRecipeSummary(row: Recipe): RecipeSummary {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    cuisine: row.cuisine,
    servings: row.servings,
    prepTimeMins: row.prep_time_mins,
    cookTimeMins: row.cook_time_mins,
    difficulty: row.difficulty,
    allergyFlags: row.allergy_flags ?? [],
    tags: row.tags ?? [],
    isFavorite: row.is_favorite,
    rating: row.rating,
    ingredients: parseIngredients(row.ingredients),
  };
}

export async function listRecipes(
  scope: ServiceScope,
  input: { query?: string | null; category?: string | null; favoritesOnly?: boolean; limit?: number } = {},
): Promise<ServiceResult<RecipeSummary[]>> {
  let q = scope.db
    .from('family_recipes')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('is_favorite', { ascending: false })
    .order('name', { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  if (input.category && RECIPE_CATEGORIES.includes(input.category)) q = q.eq('category', input.category);
  if (input.favoritesOnly) q = q.eq('is_favorite', true);
  const term = input.query?.trim().replace(/[%_]/g, (m) => `\\${m}`);
  if (term) q = q.ilike('name', `%${term}%`);

  const { data, error } = await q;
  if (error) {
    console.error('[service:meals] recipe read failed', error);
    return fail(describeDbError(error, 'Could not read your recipes.'), { code: SERVICE_CODES.db });
  }
  return ok((data ?? []).map(toRecipeSummary));
}

export type CreateRecipeInput = {
  name: string;
  category?: string | null;
  description?: string | null;
  cuisine?: string | null;
  servings?: number | null;
  prepTimeMins?: number | null;
  cookTimeMins?: number | null;
  difficulty?: string | null;
  ingredients?: Ingredient[];
  instructions?: string[];
  tags?: string[];
  allergyFlags?: string[];
  sourceUrl?: string | null;
  /** True when the assistant wrote the recipe rather than a person pasting one. */
  aiGenerated?: boolean;
};

export async function createRecipe(scope: ServiceScope, input: CreateRecipeInput): Promise<ServiceResult<RecipeSummary>> {
  const name = input.name?.trim() ?? '';
  if (!name) return fail('A recipe needs a name.', { code: SERVICE_CODES.invalidInput });
  const category = input.category && RECIPE_CATEGORIES.includes(input.category) ? input.category : 'dinner';
  const difficulty = input.difficulty && DIFFICULTIES.includes(input.difficulty) ? input.difficulty : 'medium';
  const servings = Number.isFinite(input.servings) && (input.servings as number) > 0 ? Math.round(input.servings as number) : 4;
  const ingredients = (input.ingredients ?? []).filter((i) => i.name?.trim());
  const instructions = (input.instructions ?? []).map((s) => s.trim()).filter(Boolean);

  return withIdempotency<RecipeSummary>(
    scope,
    {
      operation: 'meals.createRecipe',
      input: { name, category },
      find: async () => {
        const { data, error } = await scope.db
          .from('family_recipes')
          .select('*')
          .eq('family_id', scope.familyId)
          .ilike('name', name.replace(/[%_]/g, (m) => `\\${m}`))
          .limit(1)
          .maybeSingle();
        if (error) {
          console.error('[service:meals] duplicate recipe probe failed', error);
          return fail(describeDbError(error, 'Could not check for a duplicate recipe.'), { code: SERVICE_CODES.db });
        }
        return ok(data ? toRecipeSummary(data) : null);
      },
    },
    async () => {
      const { data, error } = await scope.db
        .from('family_recipes')
        .insert({
          family_id: scope.familyId,
          name,
          category,
          description: input.description?.trim() || null,
          cuisine: input.cuisine?.trim() || null,
          servings,
          prep_time_mins: input.prepTimeMins ?? null,
          cook_time_mins: input.cookTimeMins ?? null,
          difficulty,
          // The recipe module reads `{name, quantity, unit}` — its own dialect, not the meals one.
          ingredients: ingredients.map((i) => ({ name: i.name.trim(), quantity: i.quantity ?? '', unit: i.unit ?? '' })),
          instructions,
          tags: input.tags ?? [],
          allergy_flags: input.allergyFlags ?? [],
          source_url: input.sourceUrl?.trim() || null,
          ai_generated: input.aiGenerated ?? scope.actorKind !== 'member',
          // family_recipes.created_by references auth.users (0014).
          created_by: scope.userId,
        })
        .select('*')
        .single();
      if (error || !data) {
        console.error('[service:meals] recipe create failed', error);
        return fail(describeDbError(error, 'Could not save that recipe.'), { code: SERVICE_CODES.db });
      }
      await recordActivitySafely(scope, { agent: 'meal_planner', title: `Saved the recipe ${name}`, href: '/dashboard/recipes' });
      return ok(toRecipeSummary(data));
    },
  );
}

// ── Food profile ────────────────────────────────────────────────────────────

export type MemberFoodProfile = {
  memberId: string;
  name: string;
  allergies: string[];
  dislikes: string[];
  favorites: string[];
  diet: string[];
};

export type FoodProfile = {
  members: MemberFoodProfile[];
  /** Union across everyone, for a planner that cooks one meal for the table. */
  household: { allergies: string[]; dislikes: string[]; favorites: string[]; diet: string[] };
};

/**
 * Sort a preference fact into the bucket a planner needs. Labels are free
 * text ("Doesn't eat", "Diet", "Favourite dinner"), so the match is on words
 * rather than exact strings; a preference that is not about food is dropped.
 */
export function classifyFoodFact(label: string, value: string): 'dislikes' | 'favorites' | 'diet' | 'allergies' | null {
  const text = `${label} ${value}`.toLowerCase();
  const foodish = /food|meal|dinner|lunch|breakfast|snack|dish|cuisine|eat|cook|recipe|restaurant/.test(text);
  if (/allerg|intoleran/.test(text)) return 'allergies';
  if (/vegetarian|vegan|pescatarian|kosher|halal|gluten|dairy[- ]free|nut[- ]free|keto|paleo|low[- ]carb|\bdiet\b/.test(text)) return 'diet';
  // Recall over precision here: a non-food dislike on the list costs a planner
  // nothing, while a missed "doesn't eat mushrooms" costs a family a dinner.
  if (/dislike|doesn'?t eat|won'?t eat|hates?\b|avoids?\b|can'?t stand|not a fan|picky/.test(text)) return 'dislikes';
  if (foodish && /favou?rite|go-to|loves?\b|likes?\b|enjoys?\b/.test(text)) return 'favorites';
  return null;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export async function foodProfile(scope: ServiceScope): Promise<ServiceResult<FoodProfile>> {
  const members = await getMembers(scope);
  if (!members.ok) return members;

  const [medical, favorites, facts] = await Promise.all([
    scope.db.from('medical_profiles').select('member_id, allergies').eq('family_id', scope.familyId),
    scope.db.from('family_favorites').select('member_id, kind, name').eq('family_id', scope.familyId).in('kind', ['recipe', 'meal', 'snack', 'restaurant', 'drink']),
    scope.db.from('family_facts').select('member_id, category, label, value').eq('family_id', scope.familyId).eq('category', 'preference'),
  ]);
  const readError = medical.error ?? favorites.error ?? facts.error;
  if (readError) {
    console.error('[service:meals] food profile read failed', readError);
    return fail(describeDbError(readError, 'Could not read the family food preferences.'), { code: SERVICE_CODES.db });
  }

  const profiles = new Map<string, MemberFoodProfile>(
    members.data.map((m) => [m.id, { memberId: m.id, name: m.displayName, allergies: [], dislikes: [], favorites: [], diet: [] }]),
  );
  const household = { allergies: [] as string[], dislikes: [] as string[], favorites: [] as string[], diet: [] as string[] };
  const push = (memberId: string | null, bucket: keyof typeof household, value: string) => {
    household[bucket].push(value);
    if (memberId) profiles.get(memberId)?.[bucket].push(value);
  };

  for (const row of medical.data ?? []) {
    for (const term of normalizeAllergies(row.allergies)) push(row.member_id, 'allergies', term);
  }
  for (const row of favorites.data ?? []) push(row.member_id, 'favorites', row.name);
  for (const row of facts.data ?? []) {
    const bucket = classifyFoodFact(row.label, row.value);
    if (bucket) push(row.member_id, bucket, row.value);
  }

  const memberProfiles = [...profiles.values()].map((p) => ({
    ...p, allergies: uniq(p.allergies), dislikes: uniq(p.dislikes), favorites: uniq(p.favorites), diet: uniq(p.diet),
  }));
  return ok({
    members: memberProfiles,
    household: {
      allergies: uniq(household.allergies), dislikes: uniq(household.dislikes),
      favorites: uniq(household.favorites), diet: uniq(household.diet),
    },
  });
}
