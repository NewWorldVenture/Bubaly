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

/** Roll up the board for the console header + "needs attention" badge. */
export function feedbackAdminSummary(ideas: readonly IdeaRow[]): FeedbackAdminSummary {
  const byStatus = statusTally(ideas);
  return {
    total: ideas.length,
    needsReview: byStatus.under_review,
    active: byStatus.planned + byStatus.in_progress,
    shipped: byStatus.shipped,
    declined: byStatus.declined,
    totalVotes: ideas.reduce((n, i) => n + (i.vote_count || 0), 0),
    totalComments: ideas.reduce((n, i) => n + (i.comment_count || 0), 0),
    byStatus,
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
