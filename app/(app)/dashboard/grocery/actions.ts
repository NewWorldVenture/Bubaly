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
import type { Substitution } from '@/lib/meals/substitutions';
import { createTransaction } from '@/lib/services/finances';
import {
  addFromMealPlan, addItems, checkItem, clearChecked, recordShoppingTrip, removeItem,
  type GroceryItemInput,
} from '@/lib/services/groceries';
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

// ── The loop's two ends ─────────────────────────────────────────────────────
//
// M10's gap was never the maths. `addFromMealPlan` (ingredients − pantry − what
// is already listed) and `pantryAdjust` both existed and were both tested; what
// did not exist was a way for a person to reach either of them. The plan → list
// step was exposed only as an AI tool and a planner-template step, so a family
// who never asked the concierge for anything saw the loop's two ends and no
// middle. These two actions are that middle.

export type MealPlanToListResult =
  | {
      ok: true;
      listId: string;
      added: number;
      skipped: string[];
      inPantry: string[];
      meals: { id: string; name: string; date: string }[];
      /** Swaps the family's own allergy/preference/pantry rows forced, each with its reason. */
      substitutions: Substitution[];
    }
  | { ok: false; error: string };

/**
 * "Add this week's plan to the list."
 *
 * Dates come from the caller because the meals module knows which week it is
 * showing; omit them and the service takes the family's coming seven days in
 * their own zone.
 */
export async function addMealPlanToGroceryListAction(
  input: { from?: string | null; to?: string | null; listId?: string | null; usePantry?: boolean } = {},
): Promise<MealPlanToListResult> {
  const t = await getTranslations();
  const scope = await groceryScope();
  try {
    const result = await addFromMealPlan(scope, {
      from: input.from ?? null,
      to: input.to ?? null,
      listId: input.listId ?? null,
      usePantry: input.usePantry,
    });
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath(PATH);
    revalidatePath('/dashboard/meals');
    return {
      ok: true,
      listId: result.data.listId,
      added: result.data.added.length,
      skipped: result.data.skipped,
      inPantry: result.data.inPantry,
      meals: result.data.meals,
      substitutions: result.data.substitutions,
    };
  } catch (err) {
    console.error('[grocery-action] add from meal plan failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotAddTheMeal')) };
  }
}

export type ShoppingTripActionResult =
  | {
      ok: true;
      /** Names that reached the pantry. */
      pantryUpdated: string[];
      /** Names the pantry write refused, with why. Those lines are still checked on the list. */
      pantryFailed: { name: string; error: string }[];
      /**
       * Names that reached the pantry and could not be taken off the list.
       * Non-empty means tapping again WOULD double-count them, so the caller
       * says so instead of showing a clean success.
       */
      clearFailed: { name: string; error: string }[];
      cleared: number;
      /**
       * TRUE ONLY WHEN A `transactions` ROW EXISTS. There is no optimistic
       * spelling of this: the flag is set from the service's own result, and a
       * shop with no amount typed sets it false rather than "recorded".
       */
      purchaseRecorded: boolean;
      /** Why the purchase did not land, when an amount was given and it failed. */
      purchaseError?: string;
    }
  | { ok: false; error: string };

/**
 * The end of a shop: what was ticked off goes into the pantry, and — only when
 * a person typed an amount — the charge goes onto the household books.
 *
 * The two writes are ordered so that the failure modes are the harmless ones.
 * The pantry and the list move first, through the groceries service, line by
 * line — each bought line is put away and taken off the list together, so a
 * retry after a partial failure sees only the lines that never landed. The
 * purchase is last, through the finances service, which is also the one that
 * can refuse (a child cannot record a purchase). A refusal there therefore
 * leaves a correctly-stocked pantry and an honest message, and a retry finds
 * nothing checked and does nothing — rather than a second charge.
 *
 * `amount` is deliberately optional and deliberately not defaulted. Most shops
 * are not entered with a receipt to hand, and a made-up total is worse on a
 * family's books than no total at all.
 */
export async function recordShoppingTripAction(input: {
  listId: string;
  /** Dollars. Anything not above zero means "no receipt", not "free". */
  amount?: number | null;
  merchant?: string | null;
}): Promise<ShoppingTripActionResult> {
  const t = await getTranslations();
  if (!input?.listId) return { ok: false, error: t('actions.thatListCouldNotBe') };
  const scope = await groceryScope();
  try {
    const trip = await recordShoppingTrip(scope, { listId: input.listId });
    if (!trip.ok) return { ok: false, error: trip.error };

    let purchaseRecorded = false;
    let purchaseError: string | undefined;
    const amount = typeof input.amount === 'number' && Number.isFinite(input.amount) ? input.amount : null;
    // Only a shop that completed gets a charge. Anything still on the list —
    // a line the pantry refused, or a line put away that would not clear —
    // means the family will do this again, and a purchase recorded now would
    // be recorded twice. The caller shows those names and keeps the amount in
    // the form.
    if (amount !== null && amount > 0
      && trip.data.pantryFailed.length === 0 && trip.data.clearFailed.length === 0) {
      const merchant = input.merchant?.trim() || null;
      const purchase = await createTransaction(scope, {
        name: merchant ? `Groceries — ${merchant}` : 'Groceries',
        amount,
        type: 'expense',
        category: 'Groceries',
        merchant,
        source: 'manual',
      });
      purchaseRecorded = purchase.ok;
      if (!purchase.ok) purchaseError = purchase.error;
    }

    revalidatePath(PATH);
    revalidatePath('/dashboard/pantry');
    if (purchaseRecorded) revalidatePath('/dashboard/billing');
    return {
      ok: true,
      pantryUpdated: trip.data.pantryUpdated,
      pantryFailed: trip.data.pantryFailed,
      clearFailed: trip.data.clearFailed,
      cleared: trip.data.cleared,
      purchaseRecorded,
      ...(purchaseError ? { purchaseError } : {}),
    };
  } catch (err) {
    console.error('[grocery-action] shopping trip failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotRecordThatShopping')) };
  }
}
