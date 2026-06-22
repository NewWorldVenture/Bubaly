import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { MealVoteClient, type VoteView } from './vote-client';

export const metadata: Metadata = { title: 'Meal Voting' };
export const dynamic = 'force-dynamic';

export default async function MealVotePage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [{ data: votes }, { data: options }, { data: ballots }, { data: recipes }] = await Promise.all([
    supabase.from('meal_votes').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20),
    supabase.from('meal_vote_options').select('id, vote_id, recipe_id, label, photo_url').eq('family_id', familyId),
    supabase.from('meal_vote_ballots').select('vote_id, option_id, member_id, choice').eq('family_id', familyId),
    supabase.from('family_recipes').select('id, name, photo_url').eq('family_id', familyId).order('is_favorite', { ascending: false }).order('updated_at', { ascending: false }).limit(100),
  ]);

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
