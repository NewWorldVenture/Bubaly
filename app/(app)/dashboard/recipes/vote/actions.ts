'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { tallyVotes, winningOption } from '@/lib/recipes/voting';
import type { Database } from '@/lib/database.types';

type Json = Database['public']['Tables']['grocery_items']['Insert'];
type Result = { ok: true; id?: string } | { ok: false; error: string };

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
  if (error || !vote) return { ok: false, error: error?.message ?? 'Could not create vote' };

  const rows = options.map((o) => ({
    vote_id: vote.id, family_id: familyId,
    recipe_id: o.recipeId || null, label: o.label.trim(), photo_url: o.photoUrl || null,
  }));
  const { error: optErr } = await supabase.from('meal_vote_options').insert(rows);
  if (optErr) return { ok: false, error: optErr.message };

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
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/recipes/vote');
  return { ok: true };
}

/** Close a vote and stamp the winning option (highest score). */
export async function closeMealVote(voteId: string): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const [{ data: options }, { data: ballots }] = await settleAll([
    supabase.from('meal_vote_options').select('id').eq('vote_id', voteId).eq('family_id', ctx.active.familyId),
    supabase.from('meal_vote_ballots').select('option_id, choice').eq('vote_id', voteId).eq('family_id', ctx.active.familyId),
  ]);
  const ids = (options ?? []).map((o) => o.id);
  const winner = winningOption(tallyVotes(ids, (ballots ?? []) as { option_id: string; choice: string }[]));
  const { error } = await supabase.from('meal_votes')
    .update({ status: 'closed', winner_option_id: winner })
    .eq('id', voteId).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/recipes/vote');
  return { ok: true };
}

/** Reopen a closed vote. */
export async function reopenMealVote(voteId: string): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('meal_votes').update({ status: 'open', winner_option_id: null }).eq('id', voteId).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/recipes/vote');
  return { ok: true };
}

/** Add the winning recipe's ingredients to a grocery list (create one if needed). */
export async function addWinnerToGrocery(voteId: string): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: vote } = await supabase.from('meal_votes').select('winner_option_id').eq('id', voteId).eq('family_id', familyId).maybeSingle();
  if (!vote?.winner_option_id) return { ok: false, error: t('actions.noWinnerYetCloseThe') };
  const { data: option } = await supabase.from('meal_vote_options').select('recipe_id, label').eq('id', vote.winner_option_id).maybeSingle();
  if (!option?.recipe_id) return { ok: false, error: t('actions.theWinningOptionIsNot') };
  const { data: recipe } = await supabase.from('family_recipes').select('ingredients').eq('id', option.recipe_id).eq('family_id', familyId).maybeSingle();
  const ingredients = (recipe?.ingredients as unknown as { name: string; quantity?: string; unit?: string }[]) ?? [];
  if (ingredients.length === 0) return { ok: false, error: t('actions.thatRecipeHasNoIngredients') };

  // Get or create a default grocery list.
  // Both archive columns, as lib/services/groceries explains: only `archived_at`
  // is ever written, so an `is_archived`-only reader hands the shopping list a
  // list the family already put away.
  const { data: list } = await supabase.from('grocery_lists').select('id').eq('family_id', familyId)
    .eq('is_archived', false).is('archived_at', null).order('created_at').limit(1).maybeSingle();
  let listId = list?.id;
  if (!listId) {
    const { data: created, error } = await supabase.from('grocery_lists').insert({ family_id: familyId, name: 'Groceries', created_by: ctx.user.id }).select('id').single();
    if (error || !created) return { ok: false, error: error?.message ?? 'Could not create a grocery list' };
    listId = created.id;
  }

  const items: Json[] = ingredients.map((ing) => ({
    family_id: familyId, list_id: listId!, created_by: ctx.user.id,
    name: ing.name, quantity: [ing.quantity, ing.unit].filter(Boolean).join(' ').trim() || null,
  }));
  const { error: insErr } = await supabase.from('grocery_items').insert(items);
  if (insErr) return { ok: false, error: insErr.message };
  revalidatePath('/dashboard/grocery');
  return { ok: true };
}
