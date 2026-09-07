// The write path for groceries a person adds by hand.
//
// §7's second symptom: "A parent typing 'Milk' into the grocery list when milk
// is already on it gets a second Milk line; Bubaly adding milk skips it." The
// mechanism is NOT the calendar's. `addItems` deduplicates on the NORMALISED
// NAME against the list's open items — `normalizeName` treats case, a trailing
// plural 's' and runs of whitespace as non-differences, so "Milk", "milk" and
// "milks" are one thing. Checked items are excluded on purpose: milk bought last
// week should be addable again, milk still on the list should not.
//
// Three live surfaces add to the family's list, and all three did it from the
// browser with a raw insert:
//
//   - components/modules/shopping-module.tsx — the one /dashboard/grocery
//     renders, so the symptom above is literally this one;
//   - components/modules/pantry-module.tsx — "add the low-stock items";
//   - components/modules/recipes-module.tsx — "add this recipe's ingredients",
//     the place duplicates pile up fastest, since a recipe's staples are exactly
//     what is already on the list.
//
// The last two also re-implemented `ensureDefaultList` in the browser — find the
// family's list, create one if there is none — which is the fork the service
// layer exists to remove.
//
// `skipped` is returned rather than swallowed. A family that types "Milk" and
// sees nothing happen has been told less than one that sees "Milk is already on
// your list", and only the service knows which of the two occurred.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { addItems, checkItem, clearChecked, removeItem, type GroceryItemInput } from '@/lib/services/groceries';
import { scopeFromUserContext } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';

const PATH = '/dashboard/grocery';

/** Guards a pathological paste; the column is text and the UI caps at 120. */
const MAX_ITEMS = 200;

export type AddGroceryItemsResult =
  | { ok: true; listId: string; added: number; skipped: string[] }
  | { ok: false; error: string };

export type AddGroceryItemsInput = {
  items: GroceryItemInput[];
  /** The list the surface is showing. Omit and the service resolves the family's open one. */
  listId?: string | null;
};

export async function addGroceryItemsAction(input: AddGroceryItemsInput): Promise<AddGroceryItemsResult> {
  const t = await getTranslations();
  // Outside the try: `requireUserContext` sends a signed-out caller to /login by
  // throwing, and catching that would show them a toast instead.
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  try {
    const items = (input.items ?? []).slice(0, MAX_ITEMS);
    const result = await addItems(scope, { items, listId: input.listId ?? null });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return {
      ok: true,
      listId: result.data.listId,
      added: result.data.added.length,
      skipped: result.data.skipped,
    };
  } catch (err) {
    console.error('[grocery-action] add failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotAddThoseItems')) };
  }
}

export type GroceryItemActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/** Session + scope, OUTSIDE the try: `requireUserContext` redirects by throwing. */
async function groceryScope() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  return scopeFromUserContext(ctx, supabase);
}

/** Tick an item off, or put it back. */
export async function setGroceryItemCheckedAction(itemId: string, checked: boolean): Promise<GroceryItemActionResult> {
  const t = await getTranslations();
  if (!itemId) return { ok: false, error: t('actions.thatItemCouldNotBe') };
  const scope = await groceryScope();
  try {
    const result = await checkItem(scope, itemId, checked);
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[grocery-action] check failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUpdateThatItem')) };
  }
}

export async function removeGroceryItemAction(itemId: string): Promise<GroceryItemActionResult> {
  const t = await getTranslations();
  if (!itemId) return { ok: false, error: t('actions.thatItemCouldNotBe') };
  const scope = await groceryScope();
  try {
    const result = await removeItem(scope, itemId);
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[grocery-action] remove failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotRemoveThatItem')) };
  }
}

export type ClearCheckedResult =
  | { ok: true; removed: number }
  | { ok: false; error: string };

/**
 * Empty the cart at the end of a shop.
 *
 * Takes the LIST, not a set of ids the browser collected. The client sent
 * `.in('id', checkedIds)` from whatever its last render happened to hold, so an
 * item ticked on another phone between render and tap survived the clear. The
 * service asks the database which items are checked, at the moment of asking.
 */
export async function clearCheckedGroceriesAction(listId: string): Promise<ClearCheckedResult> {
  const t = await getTranslations();
  if (!listId) return { ok: false, error: t('actions.thatListCouldNotBe') };
  const scope = await groceryScope();
  try {
    const result = await clearChecked(scope, listId);
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath(PATH);
    return { ok: true, removed: result.data.removed };
  } catch (err) {
    console.error('[grocery-action] clear checked failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotClearTheChecked')) };
  }
}
