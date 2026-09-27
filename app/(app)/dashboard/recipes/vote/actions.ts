'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { describeReadError, settle, settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { tallyVotes, winningOption } from '@/lib/recipes/voting';
import { describeActionError } from '@/lib/supabase/errors';
import { addItems, type GroceryItemInput } from '@/lib/services/groceries';
import { parseIngredients } from '@/lib/services/meals';
import { scopeFromUserContext } from '@/lib/services/scope';

type Refusal = { ok: false; error: string };
type Result = { ok: true; id?: string } | Refusal;
/** What the Grocery button did: `skipped` is what was already on the list, so the toast can say so. */
export type WinnerGroceryResult = { ok: true; added: number; skipped: string[] } | Refusal;

/** Create a meal vote with options (recipes from the vault and/or free text). */
export async function createMealVote(input: {
  title: string; mealDate?: string | null; mealType?: string | null; allowMaybe?: boolean;
  options: { recipeId?: string | null; label: string; photoUrl?: string | null }[];
}): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const title = input.title.trim();
  if (!title) return { ok: false, error: t('actions.giveTheVoteATitle') };
  const options = input.options.filter((o) => o.label.trim()).slice(0, 12);
  if (options.length < 2) return { ok: false, error: t('actions.addAtLeastTwoOptions') };

  const supabase = await createServer();
  const { data: vote, error } = await supabase.from('meal_votes').insert({
    family_id: familyId, created_by: ctx.user.id, title,
    meal_date: input.mealDate || null, meal_type: input.mealType || null,
    allow_maybe: input.allowMaybe ?? true,
  }).select('id').single();
  if (error || !vote) return { ok: false, error: describeActionError(error, 'Could not create vote') };

  const rows = options.map((o) => ({
    vote_id: vote.id, family_id: familyId,
    recipe_id: o.recipeId || null, label: o.label.trim(), photo_url: o.photoUrl || null,
  }));
  const { error: optErr } = await supabase.from('meal_vote_options').insert(rows);
  if (optErr) return { ok: false, error: describeActionError(optErr) };

  revalidatePath('/dashboard/recipes/vote');
  return { ok: true, id: vote.id };
}

/** Cast (or change) the current member's vote on an option. */
export async function castBallot(input: { voteId: string; optionId: string; choice: 'yes' | 'no' | 'maybe' }): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const memberId = ctx.active.member?.id;
  if (!memberId) return { ok: false, error: t('actions.noFamilyMemberProfileFound') };
  const supabase = await createServer();
  const { error } = await supabase.from('meal_vote_ballots').upsert({
    vote_id: input.voteId, option_id: input.optionId, family_id: ctx.active.familyId,
    member_id: memberId, choice: input.choice,
  }, { onConflict: 'option_id,member_id' });
  if (error) return { ok: false, error: describeActionError(error) };
  revalidatePath('/dashboard/recipes/vote');
  return { ok: true };
}

/** Close a vote and stamp the winning option (highest score). */
export async function closeMealVote(voteId: string): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const [{ data: options, error: optionsError }, { data: ballots, error: ballotsError }] = await settleAll([
    supabase.from('meal_vote_options').select('id').eq('vote_id', voteId).eq('family_id', ctx.active.familyId),
    supabase.from('meal_vote_ballots').select('option_id, choice').eq('vote_id', voteId).eq('family_id', ctx.active.familyId),
  ]);
  // A failed read is not "nobody voted". Coercing it to `[]` tallies nothing,
  // `winningOption` returns null for that exactly as it does for a real tie-less
  // empty vote, and the UPDATE below would stamp winner_option_id = NULL over a
  // vote the family actually decided — then toast "Vote closed". Fail closed, the
  // way the page this action serves already does (vote/page.tsx).
  const readError = optionsError ?? ballotsError;
  if (readError) return { ok: false, error: describeReadError(readError) };
  const ids = (options ?? []).map((o) => o.id);
  const winner = winningOption(tallyVotes(ids, (ballots ?? []) as { option_id: string; choice: string }[]));
  const { error } = await supabase.from('meal_votes')
    .update({ status: 'closed', winner_option_id: winner })
    .eq('id', voteId).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: describeActionError(error) };
  revalidatePath('/dashboard/recipes/vote');
  return { ok: true };
}

/** Reopen a closed vote. */
export async function reopenMealVote(voteId: string): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('meal_votes').update({ status: 'open', winner_option_id: null }).eq('id', voteId).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: describeActionError(error) };
  revalidatePath('/dashboard/recipes/vote');
  return { ok: true };
}

/** Add the winning recipe's ingredients to the family's grocery list (created if they have none). */
export async function addWinnerToGrocery(voteId: string): Promise<WinnerGroceryResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  // Each guard below was written for a benign absence — no winner stamped yet, a
  // free-text option that is not a saved recipe, a recipe with an empty
  // ingredient list (and, inside the grocery service, a family with no grocery
  // list). Every one of those absences arrives as `data: null`, which is also
  // exactly what a REFUSED read arrives as. Destructuring `data` alone therefore
  // spells a statement timeout, an exhausted pool or an expired JWT as a
  // confident claim about the family's own food: "No winner yet — close the
  // vote first." about a vote they just closed (the button that says it only
  // renders on a closed vote, and obeying it means reopening, which nulls
  // `winner_option_id` and erases the verdict), or "That recipe has no
  // ingredients." about a recipe with eight — `?? []` on the line below is what
  // launders the failure into an empty list.
  //
  // So bind the error and refuse first, the way `closeMealVote` above does and
  // the way components/modules/recipes-module.tsx and `ensureDefaultList`
  // already do on the `grocery_lists` lookup. `settle` is here because a
  // transport failure REJECTS rather than resolving with { error } (see
  // lib/supabase/settle.ts): unwrapped it threw out of the action, so the
  // client's transition had no result to toast.
  const readFailed = (label: string, error: unknown, message: string): Refusal => {
    console.error(`[recipes/vote] ${label} read failed`, { reason: describeReadError(error) });
    return { ok: false, error: message };
  };

  const { data: vote, error: voteError } = await settle(supabase.from('meal_votes').select('winner_option_id').eq('id', voteId).eq('family_id', familyId).maybeSingle());
  if (voteError) return readFailed('meal_votes', voteError, t('actions.couldNotCheckThisVote'));
  if (!vote?.winner_option_id) return { ok: false, error: t('actions.noWinnerYetCloseThe') };
  // Family-scoped like the two reads either side of it and like `closeMealVote`'s
  // own read of this table. The id comes from a family-scoped vote row, so this
  // is belt-and-braces rather than a hole being closed, but a read that answers
  // for one family should not be the one read in this action that would not.
  const { data: option, error: optionError } = await settle(supabase.from('meal_vote_options').select('recipe_id, label').eq('id', vote.winner_option_id).eq('family_id', familyId).maybeSingle());
  if (optionError) return readFailed('meal_vote_options', optionError, t('actions.couldNotCheckThisVote'));
  if (!option?.recipe_id) return { ok: false, error: t('actions.theWinningOptionIsNot') };
  const { data: recipe, error: recipeError } = await settle(supabase.from('family_recipes').select('ingredients').eq('id', option.recipe_id).eq('family_id', familyId).maybeSingle());
  if (recipeError) return readFailed('family_recipes', recipeError, t('actions.couldNotCheckThisVote'));
  // Read through the one parser of the recipe-ingredients JSON rather than a
  // cast. The column is untyped jsonb with more than one writer, and the service
  // below refuses the WHOLE add when any single item has a non-string name, so a
  // bare-string entry ("2 eggs") or a nameless one would have cost the family
  // every other ingredient. `parseIngredients` keeps a string entry as its name,
  // reads `quantity` or `qty` (string or number), and drops an entry with no
  // name, which could never have been a grocery line anyway.
  const ingredients = parseIngredients(recipe?.ingredients);
  if (ingredients.length === 0) return { ok: false, error: t('actions.thatRecipeHasNoIngredients') };

  // Into the list through the grocery service, the way the recipe vault's own
  // "add this recipe's ingredients" already goes (recipes-module.tsx ->
  // addGroceryItemsAction -> `addItems`). This action used to find-or-create
  // the list and INSERT the rows itself, which skipped every rule `addItems`
  // exists to enforce: no duplicate check, so tapping Grocery twice on the same
  // won vote, or adding taco night when the tortillas were already there, put a
  // second copy of every line on the list and still toasted "Added"; no aisle,
  // so the whole dinner sat in an uncategorised heap at the bottom; no
  // read-back and no household trail entry, so the add never appeared in the
  // family's activity. Resolving the list is `ensureDefaultList`'s job too, and
  // it already refuses on a failed lookup instead of creating a second
  // "Groceries" over the one the family shops from.
  //
  // Not screened for allergies, and not by omission here: `addItems` screens
  // nothing, the fail-closed dietary check lives only in `addFromMealPlan`, and
  // the vault's per-recipe button is exactly as unscreened as this one. Where
  // dish-derived adds get screened is one decision for both buttons, not a
  // check bolted onto one of them.
  const scope = scopeFromUserContext(ctx, supabase);
  const items: GroceryItemInput[] = ingredients.map((ing) => ({
    name: ing.name,
    quantity: [ing.quantity, ing.unit].filter(Boolean).join(' ').trim() || null,
  }));
  let added: Awaited<ReturnType<typeof addItems>>;
  try {
    added = await addItems(scope, { items });
  } catch (err) {
    // The service's reads are not `settle`-wrapped, so a request that never
    // completed REJECTS out of it. Report it as the failure it is rather than
    // letting it escape the action with no result for the client to toast.
    // Not "could not add": the rejection can come from the insert or the
    // read-back AFTER the rows landed, and nothing here can tell which. Say
    // only what is known, and point at the list; a retry is safe because the
    // service skips what is already on it.
    console.error('[recipes/vote] grocery add failed', { reason: describeReadError(err) });
    return { ok: false, error: t('actions.couldNotConfirmWhetherTheWinning') };
  }
  if (!added.ok) {
    // The service's own sentence, as addGroceryItemsAction passes it: it is the
    // one that knows WHICH step failed, and one of them ("Could not confirm the
    // added items. Refresh the list before trying again.") is reached only after
    // the insert succeeded, where a generic "Could not add those items." is false.
    console.error('[recipes/vote] grocery add refused', { code: added.code, reason: added.error });
    return { ok: false, error: added.error };
  }
  revalidatePath('/dashboard/grocery');
  return { ok: true, added: added.data.added.length, skipped: added.data.skipped };
}
