// The write path for the meal plan a family fills in by hand.
//
// Three writes on the meals page went straight from the browser to PostgREST:
// planning a meal into a slot, clearing one, and ticking a grocery item off the
// week's list. All three filtered `id` alone and left tenancy to RLS.
//
// The grocery tick-off lives in the grocery action file rather than being
// duplicated here — it is the same act on the same table as the shopping page's,
// and two spellings of one operation is how the forks this work removes began.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ensureMealByName, removeSlot, setSlot, type Meal, type MealLibraryInput, type PlanEntryInput, type PlanSlot } from '@/lib/services/meals';
import { scopeFromUserContext } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';

const PATH = '/dashboard/meals';

export type MealPlanActionResult =
  | { ok: true; id: string; slot: PlanSlot }
  | { ok: false; error: string };

/** Session + scope, OUTSIDE the try: `requireUserContext` redirects by throwing. */
async function mealScope() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  return scopeFromUserContext(ctx, supabase);
}

/**
 * Put a meal in a slot.
 *
 * `setSlot` REPLACES what is already there rather than stacking a second row on
 * the same date and meal type — which the raw insert did, leaving two dinners on
 * one Tuesday with nothing to say which the family meant.
 */
export async function planMealAction(input: PlanEntryInput): Promise<MealPlanActionResult> {
  const t = await getTranslations();
  if (!input || !input.date) return { ok: false, error: t('actions.pickAMealAndA') };
  const scope = await mealScope();

  try {
    const result = await setSlot(scope, input);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    const { replaced: _replaced, ...slot } = result.data;
    return { ok: true, id: slot.id, slot };
  } catch (err) {
    console.error('[meal-action] plan failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotAddThatMeal')) };
  }
}

export async function createMealAction(input: MealLibraryInput): Promise<{ ok: true; meal: Meal } | { ok: false; error: string }> {
  const t = await getTranslations();
  const scope = await mealScope();
  try {
    const result = await ensureMealByName(scope, input);
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath(PATH);
    return { ok: true, meal: result.data.meal };
  } catch (err) {
    console.error('[meal-action] create failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotAddThatMeal')) };
  }
}

export async function removeMealPlanAction(planId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const t = await getTranslations();
  if (!planId) return { ok: false, error: t('actions.thatPlannedMealCouldNot') };
  const scope = await mealScope();

  try {
    const result = await removeSlot(scope, planId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[meal-action] remove failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotClearThatMeal')) };
  }
}
