import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { readAllAsQuery } from '@/lib/supabase/read-all';
import { ErrorState } from '@/components/ui/states';
import { MealVoteClient, type VoteView } from './vote-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('dashboardRecipesVoteVoteClient.mealVoting') };
}
export const dynamic = 'force-dynamic';

/**
 * The most options and ballots the twenty votes on this page can hold before
 * the read refuses rather than shows a part of them. Generous — twenty votes of
 * a dozen options and a large household's ballots fit many times over — and a
 * real ceiling, because a capped read is silent.
 */
const VOTE_OPTION_MAX = 2_000;
const VOTE_BALLOT_MAX = 20_000;

export default async function MealVotePage() {
  const t = await getTranslations();
  // Part of Recipes: it answers to that feature's tier, not just a session.
  const ctx = await requireFeature('/dashboard/recipes');
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [votesRes, recipesRes] = await settleAll([
    supabase.from('meal_votes').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20),
    supabase.from('family_recipes').select('id, name, photo_url').eq('family_id', familyId).order('is_favorite', { ascending: false }).order('updated_at', { ascending: false }).limit(100),
  ]);
  // Only the shown votes' options and ballots, read whole. These were every
  // option and ballot the family had EVER cast, unordered and unpaged, and past
  // PostgREST's silent 1,000-row cap the open vote at the top came back with
  // ballots missing — wrong tallies, a wrong leader, "you haven't voted" — and
  // no error. Paged to a real ceiling, which refuses rather than truncates.
  const voteIds = (votesRes.data ?? []).map((v) => v.id);
  const [optionsRes, ballotsRes] = await settleAll(voteIds.length === 0
    ? [Promise.resolve({ data: [], error: null }), Promise.resolve({ data: [], error: null })] as const
    : [
      readAllAsQuery<{ id: string; vote_id: string; recipe_id: string | null; label: string; photo_url: string | null }>((from, to) =>
        supabase.from('meal_vote_options').select('id, vote_id, recipe_id, label, photo_url').eq('family_id', familyId)
          .in('vote_id', voteIds).order('vote_id').order('id').range(from, to), { max: VOTE_OPTION_MAX }),
      readAllAsQuery<{ vote_id: string; option_id: string; member_id: string; choice: string }>((from, to) =>
        supabase.from('meal_vote_ballots').select('vote_id, option_id, member_id, choice').eq('family_id', familyId)
          .in('vote_id', voteIds).order('vote_id').order('id').range(from, to), { max: VOTE_BALLOT_MAX }),
    ] as const);

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
