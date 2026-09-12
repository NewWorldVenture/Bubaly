// The single grocery-list implementation.
//
// Four separate get-or-create-the-list implementations exist in the repo today
// (`lib/assistant/tools.ts ensureGroceryList`, `lib/capture/save.ts`, the
// shopping module, the recipe module) and they disagree about the default
// name, so a family can end up with "Groceries" and "Shopping" side by side
// depending on which surface they used. `ensureDefaultList` is the one
// implementation: oldest un-archived list wins, and a list is created only
// when the family genuinely has none.
//
// `grocery_lists.created_by` and `grocery_items.created_by` reference
// `auth.users` (0002), so `scope.userId` is correct here — the opposite of the
// todo tables. Verified against the migration, not assumed.
//
// Not implemented in this pass, deliberately rather than as a stub:
// `assignList` needs `grocery_items.assigned_to_id` (added by 0014) which is
// absent from the hand-maintained `lib/database.types.ts`.
//
// `addFromMealPlan` (ingredients − pantry − what is already on the list) and
// the pantry helpers live at the bottom of this file. They supersede the
// `grocery_from_meal_plan` RPC in migration 0005, which creates a fresh list
// per call and adds every ingredient regardless of what is in the cupboard;
// the RPC stays in place but nothing calls it.
import 'server-only';
import type { PantryLocation, Tables } from '@/lib/database.types';
import {
  applySubstitutions, collectDietaryConstraints, type Substitution,
} from '@/lib/meals/substitutions';
import { expiringSoon, lowStockItems, PANTRY_LOCATIONS } from '@/lib/pantry/logic';
import { describeDbError } from '@/lib/supabase/errors';
import { settleAll } from '@/lib/supabase/settle';
import { recordActivitySafely } from '../activity';
import { isDayKey, parseIngredients, type Ingredient } from '../meals';
import { dayKeyInTz, scopeNow } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type GroceryList = Tables<'grocery_lists'>;
export type GroceryItem = Tables<'grocery_items'>;

/** The name a list is created under when the family has none. Matches 0002's column default. */
export const DEFAULT_GROCERY_LIST_NAME = 'Groceries';

/**
 * "Not archived", asked of BOTH columns that answer it.
 *
 * `grocery_lists` carries two: `is_archived` from 0002 and `archived_at` from
 * 0014, added when the table grew multi-store lists. Nothing in the application
 * ever sets `is_archived` to true — the only archive writer is the shopping
 * module, which stamps `archived_at`. So a family who archives their list sees
 * it disappear from the shopping page while every `is_archived`-only reader,
 * this service included, still calls it the family's open list. Bubaly then adds
 * the milk to a list nobody can see.
 *
 * Reading both is the conservative repair: it fixes the lists already archived
 * as well as the ones archived next, and it changes no write. Consolidating the
 * two columns is a migration and a decision about which one wins, and does not
 * belong in the same commit as the read that stops being wrong.
 */
/**
 * Store-aisle keywords, longest-match-wins. Categories exist so a list can be
 * walked in one pass through the store instead of criss-crossing it; an
 * uncategorised item sorts to the end rather than into a wrong aisle.
 */
const AISLES: { category: string; keywords: string[] }[] = [
  { category: 'Produce', keywords: ['apple', 'banana', 'lettuce', 'spinach', 'tomato', 'onion', 'garlic', 'potato', 'carrot', 'pepper', 'broccoli', 'cucumber', 'lemon', 'lime', 'berries', 'strawberr', 'blueberr', 'grape', 'avocado', 'celery', 'mushroom', 'salad', 'herb', 'cilantro', 'parsley', 'kale', 'zucchini'] },
  { category: 'Dairy', keywords: ['milk', 'cheese', 'yogurt', 'yoghurt', 'butter', 'cream', 'egg', 'sour cream', 'cottage'] },
  { category: 'Meat & Seafood', keywords: ['chicken', 'beef', 'pork', 'turkey', 'bacon', 'sausage', 'salmon', 'shrimp', 'fish', 'ground meat', 'steak', 'ham', 'mince'] },
  { category: 'Bakery', keywords: ['bread', 'bagel', 'tortilla', 'bun', 'roll', 'muffin', 'croissant', 'pita', 'cake'] },
  { category: 'Frozen', keywords: ['frozen', 'ice cream', 'popsicle', 'peas', 'waffle'] },
  { category: 'Pantry', keywords: ['rice', 'pasta', 'flour', 'sugar', 'oil', 'vinegar', 'bean', 'lentil', 'canned', 'sauce', 'soup', 'cereal', 'oat', 'peanut butter', 'jam', 'honey', 'spice', 'salt', 'pepper corn', 'broth', 'stock', 'noodle'] },
  { category: 'Snacks', keywords: ['chip', 'cracker', 'cookie', 'candy', 'chocolate', 'popcorn', 'granola', 'pretzel', 'nuts'] },
  { category: 'Beverages', keywords: ['water', 'juice', 'soda', 'coffee', 'tea', 'seltzer', 'sparkling', 'lemonade'] },
  { category: 'Household', keywords: ['paper towel', 'toilet paper', 'detergent', 'soap', 'shampoo', 'toothpaste', 'trash bag', 'dish', 'cleaner', 'sponge', 'foil', 'wrap', 'diaper', 'wipe'] },
];

/**
 * Best-guess aisle for an item name. Pure and exported so the mapping can be
 * unit-tested and reused; returns null when nothing matches, which the caller
 * stores as a null category rather than guessing.
 */
export function categorizeGroceryItem(name: string): string | null {
  const text = name.toLowerCase();
  let best: { category: string; length: number } | null = null;
  for (const aisle of AISLES) {
    for (const keyword of aisle.keywords) {
      if (text.includes(keyword) && (!best || keyword.length > best.length)) {
        best = { category: aisle.category, length: keyword.length };
      }
    }
  }
  return best?.category ?? null;
}

/** Normalised form used for duplicate detection: case, plural 's' and spacing are not differences. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '');
}

export async function ensureDefaultList(scope: ServiceScope): Promise<ServiceResult<{ id: string; created: boolean }>> {
  const { data: existing, error: lookupError } = await scope.db
    .from('grocery_lists')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('is_archived', false)
    .is('archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (lookupError) {
    console.error('[service:groceries] list lookup failed', lookupError);
    return fail(describeDbError(lookupError, 'Could not open your shopping list.'), { code: SERVICE_CODES.db });
  }
  if (existing?.id) return ok({ id: existing.id, created: false });

  const { data, error } = await scope.db
    .from('grocery_lists')
    // created_by references auth.users (0002).
    .insert({ family_id: scope.familyId, name: DEFAULT_GROCERY_LIST_NAME, created_by: scope.userId })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[service:groceries] list create failed', error);
    return fail(describeDbError(error, 'Could not create a shopping list.'), { code: SERVICE_CODES.db });
  }
  return ok({ id: data.id, created: true });
}

export type GroceryItemInput = {
  name: string;
  quantity?: string | null;
  category?: string | null;
  /** `meals.id` the item was derived from, so the list can say "for Tuesday's tacos". */
  sourceMealId?: string | null;
};

async function writableList(scope: ServiceScope, listId?: string | null): Promise<ServiceResult<{ id: string }>> {
  if (!listId) return ensureDefaultList(scope);
  if (typeof listId !== 'string') return fail('Choose a shopping list.', { code: SERVICE_CODES.invalidInput });
  const { data, error } = await scope.db.from('grocery_lists').select('id')
    .eq('family_id', scope.familyId).eq('id', listId).maybeSingle();
  if (error) return fail(describeDbError(error, 'Could not open your shopping list.'), { code: SERVICE_CODES.db });
  if (!data || data.id !== listId) return fail('That shopping list could not be found.', { code: SERVICE_CODES.notFound });
  return ok({ id: data.id });
}

/**
 * Add items in one insert, skipping anything already on the list unchecked.
 *
 * Deduplication is on the normalised name against *open* items only: "milk"
 * added a week ago and already bought should be addable again, but adding it
 * twice before the shop should not produce two lines. Checked items are
 * therefore not part of the comparison.
 */
export async function addItems(
  scope: ServiceScope,
  input: { items: GroceryItemInput[]; listId?: string | null },
): Promise<ServiceResult<{ listId: string; added: GroceryItem[]; skipped: string[] }>> {
  if (!input || !Array.isArray(input.items) || input.items.length > 200 || input.items.some((item) =>
    !item || typeof item.name !== 'string' || item.name.length > 300
    || (item.quantity != null && (typeof item.quantity !== 'string' || item.quantity.length > 20000))
    || (item.category != null && (typeof item.category !== 'string' || item.category.length > 300)))) {
    return fail('Check the items to add.', { code: SERVICE_CODES.invalidInput });
  }
  const names = input.items.map((i) => ({ ...i, name: i.name.trim() })).filter((i) => i.name.length > 0);
  if (names.length === 0) return fail('There was nothing to add to the list.', { code: SERVICE_CODES.invalidInput });

  const list = await writableList(scope, input.listId);
  if (!list.ok) return list;
  const listId = list.data.id;

  const { data: open, error: openError } = await scope.db
    .from('grocery_items')
    .select('name')
    .eq('family_id', scope.familyId)
    .eq('list_id', listId)
    .eq('is_checked', false);
  if (openError) {
    console.error('[service:groceries] duplicate read failed', openError);
    return fail(describeDbError(openError, 'Could not read your shopping list.'), { code: SERVICE_CODES.db });
  }

  const seen = new Set((open ?? []).map((row) => normalizeName(row.name)));
  const skipped: string[] = [];
  const rows: { family_id: string; list_id: string; name: string; quantity: string | null; category: string | null; source_meal_id?: string; created_by: string | null }[] = [];
  for (const item of names) {
    const key = normalizeName(item.name);
    if (seen.has(key)) {
      skipped.push(item.name);
      continue;
    }
    seen.add(key);
    rows.push({
      family_id: scope.familyId,
      list_id: listId,
      name: item.name,
      quantity: item.quantity?.trim() || null,
      category: item.category?.trim() || categorizeGroceryItem(item.name),
      // Only present when a meal produced the item, so a plain add writes the
      // same row it always has (the column defaults to null either way).
      ...(item.sourceMealId ? { source_meal_id: item.sourceMealId } : {}),
      created_by: scope.userId,
    });
  }

  if (rows.length === 0) return ok({ listId, added: [], skipped });

  const { data, error } = await scope.db.from('grocery_items').insert(rows).select('*');
  const matches = (saved: GroceryItem, requested: Omit<typeof rows[number], 'source_meal_id'> & { source_meal_id?: string | null }) =>
    typeof saved.id === 'string' && saved.id.length > 0 && saved.family_id === requested.family_id
    && saved.list_id === requested.list_id && saved.name === requested.name && saved.quantity === requested.quantity
    && saved.category === requested.category && (saved.source_meal_id ?? null) === (requested.source_meal_id ?? null)
    && saved.created_by === requested.created_by;
  if (error || !data || data.length !== rows.length || new Set(data.map((item) => item.id)).size !== rows.length
    || rows.some((requested) => !data.some((saved) => matches(saved, requested)))) {
    console.error('[service:groceries] add items failed', error);
    return fail(describeDbError(error, 'Could not add those items.'), { code: SERVICE_CODES.db });
  }
  const { data: verified, error: verifyError } = await scope.db.from('grocery_items').select('*')
    .eq('family_id', scope.familyId).eq('list_id', listId).in('id', data.map((item) => item.id));
  if (verifyError || !verified || verified.length !== rows.length
    || data.some((saved) => !verified.some((item) => item.id === saved.id && matches(item, saved)))) {
    return fail('Could not confirm the added items. Refresh the list before trying again.', { code: SERVICE_CODES.db });
  }

  await recordActivitySafely(scope, {
    agent: 'groceries',
    action: 'create',
    title: rows.length === 1 ? `Added ${rows[0].name} to the shopping list` : `Added ${rows.length} items to the shopping list`,
    detail: rows.map((r) => r.name).join(', '),
    href: '/dashboard/grocery',
  });
  return ok({ listId, added: verified, skipped });
}

/** Everything still to buy, grouped-friendly: category first, then insertion order. */
export async function listOpen(
  scope: ServiceScope,
  input: { listId?: string | null; limit?: number } = {},
): Promise<ServiceResult<{ listId: string | null; items: GroceryItem[] }>> {
  let listId = input.listId ?? null;
  if (!listId) {
    const { data, error } = await scope.db
      .from('grocery_lists')
      .select('id')
      .eq('family_id', scope.familyId)
      .eq('is_archived', false)
      .is('archived_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[service:groceries] list read failed', error);
      return fail(describeDbError(error, 'Could not open your shopping list.'), { code: SERVICE_CODES.db });
    }
    // No list yet is an empty list, not an error — a family that has never
    // shopped should see an empty state, not a failure.
    if (!data?.id) return ok({ listId: null, items: [] });
    listId = data.id;
  }

  const { data, error } = await scope.db
    .from('grocery_items')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('list_id', listId)
    .eq('is_checked', false)
    .order('category', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 200, 1), 500));
  if (error) {
    console.error('[service:groceries] items read failed', error);
    return fail(describeDbError(error, 'Could not read your shopping list.'), { code: SERVICE_CODES.db });
  }
  return ok({ listId, items: data ?? [] });
}

export async function checkItem(scope: ServiceScope, itemId: string, checked = true): Promise<ServiceResult<GroceryItem>> {
  const { data, error } = await scope.db
    .from('grocery_items')
    .update({ is_checked: checked })
    .eq('id', itemId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:groceries] check item failed', error);
    return fail(describeDbError(error, 'Could not update that item.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That item could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'groceries',
    action: 'update',
    title: checked ? `Ticked ${data.name} off the shopping list` : `Put ${data.name} back on the shopping list`,
    href: '/dashboard/grocery',
    resourceId: data.id,
  });
  return ok(data);
}

/** Take one item off the list. Family-scoped, where the client filtered `id` alone. */
export async function removeItem(scope: ServiceScope, itemId: string): Promise<ServiceResult<{ id: string }>> {
  const { data, error } = await scope.db
    .from('grocery_items')
    .delete()
    .eq('id', itemId)
    .eq('family_id', scope.familyId)
    // The name comes back with the deleted row; asking afterwards is too late.
    .select('id, name')
    .maybeSingle();
  if (error) {
    console.error('[service:groceries] remove item failed', error);
    return fail(describeDbError(error, 'Could not remove that item.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That item could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'groceries',
    action: 'delete',
    title: `Took ${data.name} off the shopping list`,
    href: '/dashboard/grocery',
    resourceId: data.id,
  });
  return ok({ id: data.id });
}

/**
 * Remove everything already in the cart. Deleting rather than archiving
 * matches how the shopping module treats a finished trip; the meal plan that
 * generated an item keeps its own record.
 */
export async function clearChecked(scope: ServiceScope, listId: string): Promise<ServiceResult<{ removed: number }>> {
  const { data, error } = await scope.db
    .from('grocery_items')
    .delete()
    .eq('family_id', scope.familyId)
    .eq('list_id', listId)
    .eq('is_checked', true)
    .select('id, name');
  if (error) {
    console.error('[service:groceries] clear checked failed', error);
    return fail(describeDbError(error, 'Could not clear the checked items.'), { code: SERVICE_CODES.db });
  }

  const removed = data ?? [];
  // Nothing cleared is not a change, and a trail line for it would be noise.
  if (removed.length) {
    await recordActivitySafely(scope, {
      agent: 'groceries',
      action: 'delete',
      title: removed.length === 1
        ? `Cleared ${removed[0]!.name} from the shopping list`
        : `Cleared ${removed.length} bought items from the shopping list`,
      detail: removed.map((r) => r.name).join(', ').slice(0, 500),
      href: '/dashboard/grocery',
    });
  }
  return ok({ removed: removed.length });
}

// ── From the meal plan ──────────────────────────────────────────────────────

export type MealPlanGroceryInput = {
  /** `YYYY-MM-DD`, inclusive. Defaults to the family's next seven days when both are omitted. */
  from?: string | null;
  to?: string | null;
  listId?: string | null;
  /** Opt out of presence-based pantry skipping when exact weekly amounts are wanted. */
  usePantry?: boolean;
};

export type MealPlanGroceryResult = {
  listId: string;
  added: GroceryItem[];
  /** Already on the list, unbought; existing quantities are left unchanged. */
  skipped: string[];
  /** Skipped by the caller's pantry-presence preference; quantities were not compared. */
  inPantry: string[];
  /** Planned dishes the ingredients came from. */
  meals: { id: string; name: string; date: string }[];
  /**
   * Swaps the household's own rows forced: an allergy on a medical profile, a
   * food a `family_facts` preference says nobody eats, or a near-identical
   * thing already in the cupboard. Each carries its reason, and each is a
   * change that was actually written to the list — never a suggestion dressed
   * up as one.
   */
  substitutions: Substitution[];
};

/**
 * Pure planner for "what do we still need to buy": every ingredient of every
 * planned dish, minus what the pantry has in stock, folded by normalised name
 * so two dishes that both need onions produce one line. Exported so the
 * subtraction is unit-tested without a database.
 */
export function planGroceryNeeds(
  dishes: { id: string; name: string; ingredients: Ingredient[] }[],
  pantry: { name: string; quantity: number | null }[],
): { needed: GroceryItemInput[]; inPantry: string[] } {
  const stocked = new Set(pantry.filter((p) => (p.quantity ?? 0) > 0).map((p) => normalizeName(p.name)));
  const needed = new Map<string, GroceryItemInput>();
  const inPantry: string[] = [];
  for (const dish of dishes) {
    for (const ing of dish.ingredients) {
      const key = normalizeName(ing.name);
      if (!key) continue;
      if (stocked.has(key)) {
        if (!inPantry.includes(ing.name)) inPantry.push(ing.name);
        continue;
      }
      const existing = needed.get(key);
      if (existing) {
        // Two dishes want the same thing: keep one line, but note both amounts
        // rather than silently dropping one — "2 lb + 1 lb" is honest, a
        // summed quantity across "2 lb" and "1 cup" would be fiction.
        const qty = [ing.quantity, ing.unit].filter(Boolean).join(' ') || null;
        existing.quantity = `${existing.quantity || 'amount unspecified'} + ${qty || 'amount unspecified'}`;
        continue;
      }
      needed.set(key, {
        name: ing.name,
        quantity: [ing.quantity, ing.unit].filter(Boolean).join(' ') || null,
        sourceMealId: dish.id,
      });
    }
  }
  return { needed: [...needed.values()], inPantry };
}

export async function addFromMealPlan(scope: ServiceScope, input: MealPlanGroceryInput = {}): Promise<ServiceResult<MealPlanGroceryResult>> {
  if (input.usePantry !== undefined && typeof input.usePantry !== 'boolean') {
    return fail('Choose whether to skip pantry ingredients.', { code: SERVICE_CODES.invalidInput });
  }
  let from = input.from ?? null;
  let to = input.to ?? null;
  if (!from && !to) {
    // "The coming week" in the family's zone, not the server's.
    const now = scopeNow(scope);
    from = dayKeyInTz(now, scope.tz);
    to = dayKeyInTz(new Date(now.getTime() + 6 * 86_400_000), scope.tz);
  }
  from = from ?? to;
  to = to ?? from;
  if (!isDayKey(from) || !isDayKey(to)) return fail('Dates must look like 2026-09-07.', { code: SERVICE_CODES.invalidInput });
  if (to < from) return fail('The end date is before the start date.', { code: SERVICE_CODES.invalidInput });

  const { data: plans, error: planError } = await scope.db
    .from('meal_plans')
    .select('meal_id, plan_date')
    .eq('family_id', scope.familyId)
    .gte('plan_date', from)
    .lte('plan_date', to)
    .order('plan_date', { ascending: true });
  if (planError) {
    console.error('[service:groceries] meal plan read failed', planError);
    return fail(describeDbError(planError, 'Could not read the meal plan.'), { code: SERVICE_CODES.db });
  }
  const mealIds = [...new Set((plans ?? []).map((p) => p.meal_id).filter((id): id is string => Boolean(id)))];
  if (mealIds.length === 0) {
    return fail('There are no meals planned for those days yet.', { code: SERVICE_CODES.notFound });
  }

  const [mealsRes, pantryRes] = await settleAll([
    scope.db.from('meals').select('id, name, ingredients').eq('family_id', scope.familyId).in('id', mealIds),
    input.usePantry === false ? Promise.resolve({ data: [], error: null })
      : scope.db.from('pantry_items').select('name, quantity').eq('family_id', scope.familyId),
  ]);
  const readError = mealsRes.error ?? pantryRes.error;
  if (readError) {
    console.error('[service:groceries] meal/pantry read failed', readError);
    return fail(describeDbError(readError, 'Could not read the planned meals.'), { code: SERVICE_CODES.db });
  }

  const mealById = new Map((mealsRes.data ?? []).map((m) => [m.id, m]));
  if (mealIds.some((id) => !mealById.has(id))) {
    return fail('Some planned dishes could not be read. Refresh the meal plan before adding groceries.', { code: SERVICE_CODES.db });
  }
  const dishes = (plans ?? [])
    .map((p) => (p.meal_id ? mealById.get(p.meal_id) : null))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => ({ id: m.id, name: m.name, ingredients: parseIngredients(m.ingredients) }));
  const withoutIngredients = [...new Set(dishes.filter((dish) => dish.ingredients.length === 0).map((dish) => dish.name))];
  if (withoutIngredients.length) {
    return fail(`Add ingredients to ${withoutIngredients.slice(0, 5).join(', ')} before building the shopping list.`, { code: SERVICE_CODES.invalidInput });
  }
  const { needed: rawNeeded, inPantry } = planGroceryNeeds(dishes, pantryRes.data ?? []);

  // What the household cannot or will not eat -------------------------------
  // FAIL CLOSED. A read that errors here is not "no allergies"; putting peanut
  // butter on the list because `medical_profiles` was unreachable is exactly
  // the failure this rule exists to prevent.
  const [profilesRes, factsRes] = await Promise.all([
    scope.db.from('medical_profiles').select('allergies').eq('family_id', scope.familyId),
    scope.db.from('family_facts').select('category, label, value').eq('family_id', scope.familyId)
      .in('category', ['medical', 'preference', 'important']),
  ]);
  const constraintError = profilesRes.error ?? factsRes.error;
  if (constraintError) {
    console.error('[service:groceries] dietary constraint read failed', constraintError);
    return fail(
      describeDbError(constraintError, 'Could not check the family’s allergies, so nothing was added to the list.'),
      { code: SERVICE_CODES.db },
    );
  }
  const { allergies, dislikes } = collectDietaryConstraints({
    profiles: profilesRes.data ?? [],
    facts: factsRes.data ?? [],
  });
  const { items: needed, substitutions } = applySubstitutions(rawNeeded, {
    allergies, dislikes, pantry: pantryRes.data ?? [],
  });

  const meals = (plans ?? [])
    .filter((p) => p.meal_id && mealById.has(p.meal_id))
    .map((p) => ({ id: p.meal_id as string, name: mealById.get(p.meal_id as string)!.name, date: p.plan_date }));

  if (needed.length === 0) {
    const list = await writableList(scope, input.listId);
    if (!list.ok) return list;
    return ok({ listId: list.data.id, added: [], skipped: [], inPantry, meals, substitutions });
  }

  const res = await addItems(scope, { items: needed, listId: input.listId ?? null });
  if (!res.ok) return res;
  return ok({ listId: res.data.listId, added: res.data.added, skipped: res.data.skipped, inPantry, meals, substitutions });
}

// ── Pantry ──────────────────────────────────────────────────────────────────

export type PantryItem = Tables<'pantry_items'>;

function isPantryLocation(value: unknown): value is PantryLocation {
  return typeof value === 'string' && PANTRY_LOCATIONS.some((l) => l.id === value);
}

export async function pantryList(
  scope: ServiceScope,
  input: { location?: string | null; query?: string | null; expiringWithinDays?: number | null; lowOnly?: boolean; limit?: number } = {},
): Promise<ServiceResult<{ items: PantryItem[]; expiring: PantryItem[]; low: PantryItem[] }>> {
  let q = scope.db
    .from('pantry_items')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('location', { ascending: true })
    .order('name', { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 300, 1), 1000));
  if (isPantryLocation(input.location)) q = q.eq('location', input.location);
  const term = input.query?.trim().replace(/[%_]/g, (m) => `\\${m}`);
  if (term) q = q.ilike('name', `%${term}%`);

  const { data, error } = await q;
  if (error) {
    console.error('[service:groceries] pantry read failed', error);
    return fail(describeDbError(error, 'Could not read the pantry.'), { code: SERVICE_CODES.db });
  }
  const all = data ?? [];
  const now = (scope.now ?? new Date()).getTime();
  const expiring = expiringSoon(all, input.expiringWithinDays ?? 5, now);
  const low = lowStockItems(all);
  let items = all;
  if (input.lowOnly) items = low;
  else if (input.expiringWithinDays != null) items = expiring;
  return ok({ items, expiring, low });
}

export type PantryAdjustInput = {
  itemId?: string | null;
  /** Matched by normalised name when no id is given. */
  name?: string | null;
  /** Relative change, e.g. -1 after cooking; ignored when `quantity` is set. */
  delta?: number | null;
  /** Absolute new quantity. */
  quantity?: number | null;
  unit?: string | null;
  location?: string | null;
  /** `YYYY-MM-DD` best-by date. */
  expiresAt?: string | null;
  /** Create the item when it is not in the pantry yet. Defaults to true. */
  createIfMissing?: boolean;
};

/**
 * Change how much of something the pantry holds. Quantities never go below
 * zero — "used the last of the milk" lands on 0, which is what the low-stock
 * rule keys on; a negative count would hide the item from every alert.
 */
export async function pantryAdjust(scope: ServiceScope, input: PantryAdjustInput): Promise<ServiceResult<{ item: PantryItem; created: boolean }>> {
  const name = input.name?.trim() ?? '';
  if (!input.itemId && !name) return fail('Which pantry item?', { code: SERVICE_CODES.invalidInput });
  if (input.quantity == null && input.delta == null && !input.location && !input.expiresAt && !input.unit) {
    return fail('There is nothing to change on that item.', { code: SERVICE_CODES.invalidInput });
  }
  if (input.expiresAt && !isDayKey(input.expiresAt)) return fail('A best-by date must look like 2026-09-07.', { code: SERVICE_CODES.invalidInput });
  if (input.location && !isPantryLocation(input.location)) return fail(`"${input.location}" is not a pantry location.`, { code: SERVICE_CODES.invalidInput });
  if (input.quantity != null && !(Number.isFinite(input.quantity) && input.quantity >= 0)) {
    return fail('A quantity must be zero or more.', { code: SERVICE_CODES.invalidInput });
  }

  let existing: PantryItem | null = null;
  if (input.itemId) {
    const { data, error } = await scope.db.from('pantry_items').select('*').eq('family_id', scope.familyId).eq('id', input.itemId).maybeSingle();
    if (error) {
      console.error('[service:groceries] pantry item read failed', error);
      return fail(describeDbError(error, 'Could not read that pantry item.'), { code: SERVICE_CODES.db });
    }
    if (!data) return fail('That pantry item could not be found.', { code: SERVICE_CODES.notFound });
    existing = data;
  } else {
    const { data, error } = await scope.db.from('pantry_items').select('*').eq('family_id', scope.familyId).ilike('name', `%${name.replace(/[%_]/g, (m) => `\\${m}`)}%`).limit(20);
    if (error) {
      console.error('[service:groceries] pantry lookup failed', error);
      return fail(describeDbError(error, 'Could not look up the pantry.'), { code: SERVICE_CODES.db });
    }
    const key = normalizeName(name);
    existing = (data ?? []).find((row) => normalizeName(row.name) === key) ?? null;
  }

  if (!existing) {
    if (input.createIfMissing === false || !name) return fail(`${name || 'That item'} is not in the pantry.`, { code: SERVICE_CODES.notFound });
    const quantity = Math.max(0, input.quantity ?? Math.max(0, input.delta ?? 1));
    const { data, error } = await scope.db
      .from('pantry_items')
      .insert({
        family_id: scope.familyId,
        name,
        quantity,
        unit: input.unit?.trim() || null,
        location: isPantryLocation(input.location) ? input.location : 'pantry',
        expires_at: input.expiresAt ?? null,
        category: categorizeGroceryItem(name),
        // pantry_items.created_by references auth.users (0080).
        created_by: scope.userId,
      })
      .select('*')
      .single();
    if (error || !data) {
      console.error('[service:groceries] pantry create failed', error);
      return fail(describeDbError(error, 'Could not add that to the pantry.'), { code: SERVICE_CODES.db });
    }
    return ok({ item: data, created: true });
  }

  const nextQuantity = input.quantity != null
    ? input.quantity
    : input.delta != null ? Math.max(0, Number(existing.quantity ?? 0) + input.delta) : undefined;
  const patch: Partial<{ quantity: number; unit: string | null; location: PantryLocation; expires_at: string | null }> = {};
  if (nextQuantity !== undefined) patch.quantity = nextQuantity;
  if (input.unit !== undefined && input.unit !== null) patch.unit = input.unit.trim() || null;
  if (isPantryLocation(input.location)) patch.location = input.location;
  if (input.expiresAt) patch.expires_at = input.expiresAt;

  // A DELTA is a read-modify-write, so it races: two people unpacking the
  // shopping and each tapping +1 both read 3 and both write 4. The update
  // therefore carries the quantity it read as a condition, and a write that
  // matches no row means someone moved it first — re-read and apply the delta
  // again rather than overwrite their change. An absolute `quantity` is the
  // caller stating a figure, so it does not need the condition and does not get
  // one. Same distinction as `setGoalProgress` versus `contributeToSavingsGoal`.
  const isDelta = input.quantity == null && input.delta != null;
  let current = existing;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (isDelta) patch.quantity = Math.max(0, Number(current.quantity ?? 0) + (input.delta ?? 0));

    let write = scope.db
      .from('pantry_items')
      .update(patch)
      .eq('family_id', scope.familyId)
      .eq('id', current.id);
    if (isDelta) write = write.eq('quantity', current.quantity as number);

    const { data, error } = await write.select('*').maybeSingle();
    if (error) {
      console.error('[service:groceries] pantry update failed', error);
      return fail(describeDbError(error, 'Could not update that pantry item.'), { code: SERVICE_CODES.db });
    }
    if (data) return ok({ item: data, created: false });
    if (!isDelta) return fail('That pantry item could not be found.', { code: SERVICE_CODES.notFound });

    // Nothing matched: either the row is gone, or its quantity moved.
    const { data: fresh, error: reread } = await scope.db
      .from('pantry_items')
      .select('*')
      .eq('family_id', scope.familyId)
      .eq('id', current.id)
      .maybeSingle();
    if (reread) {
      console.error('[service:groceries] pantry re-read failed', reread);
      return fail(describeDbError(reread, 'Could not update that pantry item.'), { code: SERVICE_CODES.db });
    }
    if (!fresh) return fail('That pantry item could not be found.', { code: SERVICE_CODES.notFound });
    current = fresh;
  }

  return fail('That pantry item is being updated by someone else. Try again.', { code: SERVICE_CODES.db });
}

/**
 * Create or update a pantry item from the editor.
 *
 * Distinct from `pantryAdjust`, which exists for "we used two" and carries only
 * quantity, unit, location and expiry. The editor also sets `category`,
 * `low_threshold`, `is_staple` and `notes`; routing it through `pantryAdjust`
 * would have dropped all four silently — the same shape as the chore icon the
 * board set and `CreateChoreInput` did not carry.
 *
 * `quantity` here is an ABSOLUTE the family typed, so it needs no compare-and-set.
 */
export type SavePantryItemInput = {
  name: string;
  category?: string | null;
  location?: string | null;
  quantity?: number | null;
  unit?: string | null;
  lowThreshold?: number | null;
  expiresAt?: string | null;
  isStaple?: boolean | null;
  notes?: string | null;
};

export async function savePantryItem(
  scope: ServiceScope,
  input: SavePantryItemInput & { itemId?: string | null },
): Promise<ServiceResult<{ item: PantryItem; created: boolean }>> {
  const name = input.name?.trim() ?? '';
  if (!name) return fail('A pantry item needs a name.', { code: SERVICE_CODES.invalidInput });
  if (input.quantity != null && !(Number.isFinite(input.quantity) && input.quantity >= 0)) {
    return fail('A quantity must be zero or more.', { code: SERVICE_CODES.invalidInput });
  }
  if (input.lowThreshold != null && !(Number.isFinite(input.lowThreshold) && input.lowThreshold >= 0)) {
    return fail('A low-stock threshold must be zero or more.', { code: SERVICE_CODES.invalidInput });
  }
  if (input.expiresAt && !isDayKey(input.expiresAt)) {
    return fail('A best-by date must look like 2026-09-07.', { code: SERVICE_CODES.invalidInput });
  }
  if (input.location && !isPantryLocation(input.location)) {
    return fail(`"${input.location}" is not a pantry location.`, { code: SERVICE_CODES.invalidInput });
  }

  const fields = {
    name,
    category: input.category?.trim() || categorizeGroceryItem(name),
    location: (isPantryLocation(input.location) ? input.location : 'pantry') as PantryLocation,
    quantity: input.quantity ?? 1,
    unit: input.unit?.trim() || null,
    low_threshold: input.lowThreshold ?? null,
    expires_at: input.expiresAt || null,
    is_staple: input.isStaple ?? false,
    notes: input.notes?.trim() || null,
  };

  if (input.itemId) {
    const { data, error } = await scope.db
      .from('pantry_items')
      .update(fields)
      .eq('id', input.itemId)
      .eq('family_id', scope.familyId)
      .select('*')
      .maybeSingle();
    if (error) {
      console.error('[service:groceries] pantry save failed', error);
      return fail(describeDbError(error, 'Could not save that pantry item.'), { code: SERVICE_CODES.db });
    }
    if (!data) return fail('That pantry item could not be found.', { code: SERVICE_CODES.notFound });

    await recordActivitySafely(scope, {
      agent: 'groceries', action: 'update',
      title: `Updated ${data.name} in the pantry`, href: '/dashboard/pantry', resourceId: data.id,
    });
    return ok({ item: data, created: false });
  }

  const { data, error } = await scope.db
    .from('pantry_items')
    .insert({ ...fields, family_id: scope.familyId, created_by: scope.userId })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:groceries] pantry create failed', error);
    return fail(describeDbError(error, 'Could not add that to the pantry.'), { code: SERVICE_CODES.db });
  }

  await recordActivitySafely(scope, {
    agent: 'groceries', action: 'create',
    title: `Added ${data.name} to the pantry`, href: '/dashboard/pantry', resourceId: data.id,
  });
  return ok({ item: data, created: true });
}

/** Remove a pantry item. Family-scoped, where the module deleted on `id` alone. */
export async function removePantryItem(scope: ServiceScope, itemId: string): Promise<ServiceResult<{ id: string }>> {
  const { data, error } = await scope.db
    .from('pantry_items')
    .delete()
    .eq('id', itemId)
    .eq('family_id', scope.familyId)
    .select('id, name')
    .maybeSingle();
  if (error) {
    console.error('[service:groceries] pantry delete failed', error);
    return fail(describeDbError(error, 'Could not remove that pantry item.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That pantry item could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'groceries', action: 'delete',
    title: `Took ${data.name} out of the pantry`, href: '/dashboard/pantry', resourceId: data.id,
  });
  return ok({ id: data.id });
}

// ── The end of a shop ───────────────────────────────────────────────────────

/**
 * How much of something a grocery line represents, for the pantry.
 *
 * `grocery_items.quantity` is free text, and `planGroceryNeeds` deliberately
 * writes "2 lb + 1 cup" when two dishes want the same thing in different
 * units — a summed figure there would be fiction. The pantry needs a NUMBER,
 * so this reads the leading amount and its unit and nothing else: "2 lb + 1
 * cup" becomes two pounds, not three of something. A line with no number at
 * all is one of the thing, which is what "Milk" on a list means.
 *
 * Exported so the rounding is a tested property rather than an assumption
 * buried in a loop.
 */
export function parsePurchasedQuantity(text: string | null | undefined): { delta: number; unit: string | null } {
  const raw = (text ?? '').trim();
  if (!raw) return { delta: 1, unit: null };
  // "1 1/2 lb", "2.5kg", "3 x 400g" — take the first number and the word after it.
  const match = raw.match(/^\s*(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+(?:[.,]\d+)?))?\s*([a-zA-Z%]+)?/);
  if (!match) return { delta: 1, unit: null };
  const numerator = Number(match[1].replace(',', '.'));
  const denominator = match[2] ? Number(match[2].replace(',', '.')) : null;
  let delta = Number.isFinite(numerator) ? numerator : 1;
  if (denominator && Number.isFinite(denominator) && denominator !== 0) delta = numerator / denominator;
  if (!Number.isFinite(delta) || delta <= 0) delta = 1;
  // numeric(10,2): more precision than the column holds would be rounded away
  // by Postgres anyway, and rounding here keeps the read-modify-write honest.
  delta = Math.round(delta * 100) / 100;
  const unit = match[3]?.trim() || null;
  return { delta, unit };
}

// TODO(migration, owner approval required): an ESTIMATED total against a
// grocery budget is the one piece of M10 this pass cannot build, because no
// price column exists on either table. It needs, in one migration:
//
//   ALTER TABLE public.grocery_lists ADD COLUMN budget_cents integer;
//   ALTER TABLE public.grocery_items ADD COLUMN estimated_price_cents integer;
//
// Both nullable, RLS unchanged (the existing family-scoped policies cover new
// columns). Until they exist the shop reports what a person typed and nothing
// else: an estimate derived from a made-up price would be a number on a
// family's books that nobody gave us, which is the failure mode this whole
// item is about.

export type ShoppingTripResult = {
  listId: string;
  /** Items whose quantity landed in the pantry, by name. */
  pantryUpdated: string[];
  /**
   * Items the pantry write refused. Named rather than counted: "three items
   * did not save" is not something a person can act on.
   */
  pantryFailed: { name: string; error: string }[];
  /**
   * Items whose quantity DID land in the pantry and whose line could not then
   * be removed. The one window this loop cannot close by itself, and the one
   * case where tapping again would count a purchase twice — so it is named
   * rather than swallowed.
   */
  clearFailed: { name: string; error: string }[];
  /** Bought lines removed from the list — one per line that reached the pantry. */
  cleared: number;
};

/**
 * "We bought these" — the step that closed nothing before this.
 *
 * The list could be ticked off and cleared, and the pantry never heard about
 * it: a family that bought milk on Saturday still had a pantry that said the
 * milk ran out on Thursday, so the next plan bought milk again. This walks the
 * CHECKED lines and, for each one, adds its quantity to the pantry (creating
 * the row when the family has never had the thing before) and then removes
 * that line.
 *
 * THE UNIT OF WORK IS THE LINE, NOT THE TRIP, AND THAT IS THE WHOLE POINT.
 * `pantryAdjust` is an additive read-modify-write: doing it twice for one
 * purchase says the family owns two. Clearing the whole list at the end only
 * when every line succeeded therefore did the opposite of what it promised —
 * the milk write succeeded, the eggs write failed, nothing was cleared, the
 * modal stayed open, and the second tap added the milk again. Clearing each
 * line as soon as its own pantry write lands means a retry finds only the
 * lines that never landed, and does to them exactly what the first attempt
 * meant to.
 *
 * The money half is NOT here: a purchase is the finances service's write, the
 * caller records it, and it is recorded only when a person typed an amount —
 * a bought list is not a receipt and this service will not invent one.
 */
export async function recordShoppingTrip(
  scope: ServiceScope,
  input: { listId: string },
): Promise<ServiceResult<ShoppingTripResult>> {
  const listId = input.listId?.trim();
  if (!listId) return fail('Which shopping list?', { code: SERVICE_CODES.invalidInput });

  const { data: bought, error: readError } = await scope.db
    .from('grocery_items')
    .select('id, name, quantity')
    .eq('family_id', scope.familyId)
    .eq('list_id', listId)
    .eq('is_checked', true)
    .order('created_at', { ascending: true });
  if (readError) {
    console.error('[service:groceries] bought items read failed', readError);
    return fail(describeDbError(readError, 'Could not read what you bought.'), { code: SERVICE_CODES.db });
  }
  const items = bought ?? [];
  if (items.length === 0) {
    return fail('Tick off what you bought first — nothing on this list is checked.', { code: SERVICE_CODES.notFound });
  }

  const pantryUpdated: string[] = [];
  const pantryFailed: { name: string; error: string }[] = [];
  const clearFailed: { name: string; error: string }[] = [];
  const clearedNames: string[] = [];
  for (const item of items) {
    const { delta, unit } = parsePurchasedQuantity(item.quantity);
    const result = await pantryAdjust(scope, { name: item.name, delta, unit, createIfMissing: true });
    if (!result.ok) {
      // Never put away, so the line stays checked and the retry is its first
      // real attempt.
      pantryFailed.push({ name: item.name, error: result.error });
      continue;
    }
    pantryUpdated.push(item.name);

    // Immediately, and scoped to this row: whatever happens to the rest of the
    // trip, this quantity is now in the pantry and must not be added twice.
    const { error: clearError } = await scope.db
      .from('grocery_items')
      .delete()
      .eq('family_id', scope.familyId)
      .eq('id', item.id);
    if (clearError) {
      console.error('[service:groceries] bought line clear failed', clearError);
      clearFailed.push({ name: item.name, error: describeDbError(clearError, 'Put away, but still on the list.') });
      continue;
    }
    clearedNames.push(item.name);
  }

  if (pantryUpdated.length) {
    await recordActivitySafely(scope, {
      agent: 'groceries',
      action: 'update',
      title: pantryUpdated.length === 1
        ? `Put ${pantryUpdated[0]} away in the pantry`
        : `Put ${pantryUpdated.length} bought items away in the pantry`,
      detail: pantryUpdated.join(', ').slice(0, 500),
      href: '/dashboard/pantry',
    });
  }
  // `clearChecked` writes its own trail line; these deletes are its equivalent
  // done one row at a time, so they carry the same one.
  if (clearedNames.length) {
    await recordActivitySafely(scope, {
      agent: 'groceries',
      action: 'delete',
      title: clearedNames.length === 1
        ? `Cleared ${clearedNames[0]} from the shopping list`
        : `Cleared ${clearedNames.length} bought items from the shopping list`,
      detail: clearedNames.join(', ').slice(0, 500),
      href: '/dashboard/grocery',
    });
  }

  return ok({ listId, pantryUpdated, pantryFailed, clearFailed, cleared: clearedNames.length });
}
