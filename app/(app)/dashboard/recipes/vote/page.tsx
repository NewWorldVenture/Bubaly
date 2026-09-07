import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { ErrorState } from '@/components/ui/states';
import { MealVoteClient, type VoteView } from './vote-client';

export const metadata: Metadata = { title: 'Meal Voting' };
export const dynamic = 'force-dynamic';

export default async function MealVotePage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [votesRes, optionsRes, ballotsRes, recipesRes] = await Promise.all([
    supabase.from('meal_votes').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20),
    supabase.from('meal_vote_options').select('id, vote_id, recipe_id, label, photo_url').eq('family_id', familyId),
    supabase.from('meal_vote_ballots').select('vote_id, option_id, member_id, choice').eq('family_id', familyId),
    supabase.from('family_recipes').select('id, name, photo_url').eq('family_id', familyId).order('is_favorite', { ascending: false }).order('updated_at', { ascending: false }).limit(100),
  ]);

  // The votes, their options, the cast ballots, and the recipe picker are
  // source-of-truth: a dropped error would render an empty voting page (a family
  // misses an active meal vote, or can't start one) that lies. Fail closed on a
  // real read error; a genuinely missing table (unapplied migration) is still
  // tolerated as empty.
  const voteError = [votesRes.error, optionsRes.error, ballotsRes.error, recipesRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (voteError) {
    console.error('[dashboard/recipes/vote] meal vote read failed', voteError);
    return <ErrorState message={t('vote.couldNotLoadMealVoting')} />;
  }

  const votes = votesRes.data;
  const options = optionsRes.data;
  const ballots = ballotsRes.data;
  const recipes = recipesRes.data;

  const optionsByVote = new Map<string, VoteView['options']>();
  for (const o of options ?? []) {
    const arr = optionsByVote.get(o.vote_id) ?? [];
    arr.push({ id: o.id, recipeId: o.recipe_id, label: o.label, photoUrl: o.photo_url });
    optionsByVote.set(o.vote_id, arr);
  }
  const ballotsByVote = new Map<string, VoteView['ballots']>();
  for (const b of ballots ?? []) {
    const arr = ballotsByVote.get(b.vote_id) ?? [];
    arr.push({ optionId: b.option_id, memberId: b.member_id, choice: b.choice });
    ballotsByVote.set(b.vote_id, arr);
  }

  const views: VoteView[] = (votes ?? []).map((v) => ({
    id: v.id, title: v.title, status: v.status, mealDate: v.meal_date, mealType: v.meal_type,
    winnerOptionId: v.winner_option_id,
    options: optionsByVote.get(v.id) ?? [],
    ballots: ballotsByVote.get(v.id) ?? [],
  }));

  return <MealVoteClient votes={views} recipes={(recipes ?? []).map((r) => ({ id: r.id, name: r.name, photoUrl: r.photo_url }))} />;
}
