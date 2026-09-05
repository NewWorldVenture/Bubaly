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
// absent from the hand-maintained `lib/database.types.ts`, and
// `addFromMealPlan`/`pantryAdjust` belong with the meal-planning service.
import 'server-only';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type GroceryList = Tables<'grocery_lists'>;
export type GroceryItem = Tables<'grocery_items'>;

/** The name a list is created under when the family has none. Matches 0002's column default. */
export const DEFAULT_GROCERY_LIST_NAME = 'Groceries';

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
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '');
}

export async function ensureDefaultList(scope: ServiceScope): Promise<ServiceResult<{ id: string; created: boolean }>> {
  const { data: existing, error: lookupError } = await scope.db
    .from('grocery_lists')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('is_archived', false)
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

export type GroceryItemInput = { name: string; quantity?: string | null; category?: string | null };

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
  const names = (input.items ?? []).map((i) => ({ ...i, name: i.name?.trim() ?? '' })).filter((i) => i.name.length > 0);
  if (names.length === 0) return fail('There was nothing to add to the list.', { code: SERVICE_CODES.invalidInput });

  let listId = input.listId ?? null;
  if (!listId) {
    const list = await ensureDefaultList(scope);
    if (!list.ok) return list;
    listId = list.data.id;
  }

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
  const rows: { family_id: string; list_id: string; name: string; quantity: string | null; category: string | null; created_by: string | null }[] = [];
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
      created_by: scope.userId,
    });
  }

  if (rows.length === 0) return ok({ listId, added: [], skipped });

  const { data, error } = await scope.db.from('grocery_items').insert(rows).select('*');
  if (error) {
    console.error('[service:groceries] add items failed', error);
    return fail(describeDbError(error, 'Could not add those items.'), { code: SERVICE_CODES.db });
  }

  await recordActivitySafely(scope, {
    agent: 'groceries',
    title: rows.length === 1 ? `Added ${rows[0].name} to the shopping list` : `Added ${rows.length} items to the shopping list`,
    detail: rows.map((r) => r.name).join(', '),
    href: '/dashboard/grocery',
  });
  return ok({ listId, added: data ?? [], skipped });
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
  return ok(data);
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
    .select('id');
  if (error) {
    console.error('[service:groceries] clear checked failed', error);
    return fail(describeDbError(error, 'Could not clear the checked items.'), { code: SERVICE_CODES.db });
  }
  return ok({ removed: (data ?? []).length });
}
