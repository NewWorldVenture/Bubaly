// Pure helpers for the Super Admin feedback console. Deterministic + tested
// (tests/feedback-admin.test.ts) — no Supabase, no React.

import { statusTally, isFeedbackStatus, type IdeaRow, type FeedbackStatus } from '@/lib/feedback/board';

export type AdminFeedbackFilter = { status: 'all' | FeedbackStatus; category: string };

export type FeedbackAdminSummary = {
  total: number;
  needsReview: number;      // still under_review — the action queue
  active: number;           // planned + in_progress
  shipped: number;
  declined: number;
  totalVotes: number;
  totalComments: number;
  byStatus: Record<FeedbackStatus, number>;
};

/**
 * The board's own figures, as /admin/feedback reads them: a count of every
 * idea and of each status, and every idea's votes added up. Not a tally of the
 * ideas it lists, which are at most its newest 1,000, so past them a tally was
 * a total of the listed ideas presented as the board's.
 */
export type FeedbackBoardCounts = {
  total: number;
  byStatus: Record<FeedbackStatus, number>;
  /** null when there were more ideas than the page adds up: the tile says it is not shown. */
  totalVotes: number | null;
};

/** The console header's tiles and the status chips' counts, from the board's counts. */
export function feedbackBoardSummary({ total, byStatus, totalVotes }: FeedbackBoardCounts) {
  return {
    total,
    needsReview: byStatus.under_review,
    active: byStatus.planned + byStatus.in_progress,
    shipped: byStatus.shipped,
    declined: byStatus.declined,
    totalVotes,
    byStatus,
  };
}

/** Roll up a list of ideas the same way, every idea in hand. */
export function feedbackAdminSummary(ideas: readonly IdeaRow[]): FeedbackAdminSummary {
  const totalVotes = ideas.reduce((n, i) => n + (i.vote_count || 0), 0);
  return {
    ...feedbackBoardSummary({ total: ideas.length, byStatus: statusTally(ideas), totalVotes }),
    totalVotes,
    totalComments: ideas.reduce((n, i) => n + (i.comment_count || 0), 0),
  };
}

/** Apply the console's status + category filter to the idea list. */
export function filterIdeasForAdmin<T extends IdeaRow>(ideas: readonly T[], filter: AdminFeedbackFilter): T[] {
  return ideas.filter((i) => {
    if (filter.status !== 'all') {
      if (!isFeedbackStatus(i.status) || i.status !== filter.status) return false;
    }
    if (filter.category !== 'all' && i.category !== filter.category) return false;
    return true;
  });
}
