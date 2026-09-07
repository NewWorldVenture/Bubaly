// The write path for the pantry.
//
// The module's +/- buttons computed the new quantity in the BROWSER —
// `Math.max(0, Number(item.quantity) + delta)` from what the page last rendered
// — so two people unpacking the shopping and each tapping +1 both read 3 and
// both wrote 4. `pantryAdjust` takes the DELTA and applies it under a
// compare-and-set, so both taps count.
//
// The editor goes to `savePantryItem`, not `pantryAdjust`: `pantryAdjust` exists
// for "we used two" and carries only quantity, unit, location and expiry, so it
// would have silently dropped the category, low-stock threshold, staple flag and
// notes the editor sets.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { pantryAdjust, removePantryItem, savePantryItem, type SavePantryItemInput } from '@/lib/services/groceries';
import { scopeFromUserContext } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';

const PATH = '/dashboard/pantry';

export type PantryActionResult = { ok: true; id: string } | { ok: false; error: string };

/** Session + scope, resolved OUTSIDE the try: `requireUserContext` redirects by throwing. */
async function pantryScope() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  return scopeFromUserContext(ctx, supabase);
}

/** `delta`, never a total: the browser must not compute what the column becomes. */
export async function adjustPantryQuantityAction(itemId: string, delta: number): Promise<PantryActionResult> {
  const t = await getTranslations();
  if (!itemId) return { ok: false, error: t('actions.thatPantryItemCouldNot') };
  const scope = await pantryScope();

  try {
    const result = await pantryAdjust(scope, { itemId, delta, createIfMissing: false });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.item.id };
  } catch (err) {
    console.error('[pantry-action] adjust failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUpdateThatItem')) };
  }
}

export async function savePantryItemAction(
  itemId: string | null,
  input: SavePantryItemInput,
): Promise<PantryActionResult> {
  const t = await getTranslations();
  const scope = await pantryScope();

  try {
    const result = await savePantryItem(scope, { ...input, itemId });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.item.id };
  } catch (err) {
    console.error('[pantry-action] save failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotSaveThatItem')) };
  }
}

export async function removePantryItemAction(itemId: string): Promise<PantryActionResult> {
  const t = await getTranslations();
  if (!itemId) return { ok: false, error: t('actions.thatPantryItemCouldNot') };
  const scope = await pantryScope();

  try {
    const result = await removePantryItem(scope, itemId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[pantry-action] remove failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotRemoveThatItem')) };
  }
}
