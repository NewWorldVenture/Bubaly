// lib/marketplace/questions.ts — marketplace Q&A helpers (pure, tested).
// Splits a family's questions into the two views the inbox needs: questions on
// MY listings (that I answer) and questions I asked (waiting on / with answers).

export type QuestionLike = {
  id: string;
  listing_id: string;
  asker_member: string | null;
  answer: string | null;
  created_at: string;
};

export function isAnswered(q: { answer: string | null }): boolean {
  return typeof q.answer === 'string' && q.answer.trim().length > 0;
}

export type CategorizedQuestions<Q extends QuestionLike> = {
  /** On my listings, still unanswered — needs my reply (newest first). */
  toAnswer: Q[];
  /** On my listings, already answered (newest first). */
  answered: Q[];
  /** Questions I asked on others' listings (newest first). */
  mine: Q[];
};

/**
 * Bucket questions relative to a viewer. `myListingIds` = the listings I own;
 * `myMemberId` = me (so I don't see my own asked question in my seller inbox).
 */
export function categorizeQuestions<Q extends QuestionLike>(
  questions: Q[],
  myMemberId: string | null,
  myListingIds: Iterable<string>,
): CategorizedQuestions<Q> {
  const owned = myListingIds instanceof Set ? myListingIds : new Set(myListingIds);
  const byNewest = (a: Q, b: Q) => b.created_at.localeCompare(a.created_at);

  const onMine = questions.filter((q) => owned.has(q.listing_id));
  return {
    toAnswer: onMine.filter((q) => !isAnswered(q)).sort(byNewest),
    answered: onMine.filter((q) => isAnswered(q)).sort(byNewest),
    mine: questions.filter((q) => !owned.has(q.listing_id) && myMemberId != null && q.asker_member === myMemberId).sort(byNewest),
  };
}

/** How many questions on my listings still need an answer. */
export function unansweredCount<Q extends QuestionLike>(questions: Q[], myListingIds: Iterable<string>): number {
  const owned = myListingIds instanceof Set ? myListingIds : new Set(myListingIds);
  return questions.filter((q) => owned.has(q.listing_id) && !isAnswered(q)).length;
}
