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
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { addItems, type GroceryItemInput } from '@/lib/services/groceries';
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
    return { ok: false, error: describeActionError(err, 'Could not add those items.') };
  }
}
