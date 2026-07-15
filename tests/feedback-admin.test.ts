import { describe, it, expect } from 'vitest';
import { feedbackAdminSummary, filterIdeasForAdmin } from '@/lib/feedback/admin';
import type { IdeaRow } from '@/lib/feedback/board';

function idea(over: Partial<IdeaRow>): IdeaRow {
  return {
    id: over.id ?? crypto.randomUUID(),
    title: 'Idea', problem: null, body: null,
    category: over.category ?? 'other', impact: 'helpful', audience: 'me',
    status: over.status ?? 'under_review', admin_note: null, image_url: null,
    author_name: 'A', vote_count: over.vote_count ?? 0, comment_count: over.comment_count ?? 0,
    pinned: false, created_at: new Date().toISOString(), ...over,
  };
}

describe('feedbackAdminSummary', () => {
  it('rolls up counts, the review queue, and totals', () => {
    const ideas = [
      idea({ status: 'under_review', vote_count: 5, comment_count: 2 }),
      idea({ status: 'under_review', vote_count: 1 }),
      idea({ status: 'planned', vote_count: 10 }),
      idea({ status: 'in_progress' }),
      idea({ status: 'shipped', comment_count: 3 }),
      idea({ status: 'declined' }),
    ];
    const s = feedbackAdminSummary(ideas);
    expect(s.total).toBe(6);
    expect(s.needsReview).toBe(2);
    expect(s.active).toBe(2); // planned + in_progress
    expect(s.shipped).toBe(1);
    expect(s.declined).toBe(1);
    expect(s.totalVotes).toBe(16);
    expect(s.totalComments).toBe(5);
    expect(s.byStatus.under_review).toBe(2);
  });

  it('handles an empty board', () => {
    const s = feedbackAdminSummary([]);
    expect(s).toMatchObject({ total: 0, needsReview: 0, active: 0, totalVotes: 0 });
  });
});

describe('filterIdeasForAdmin', () => {
  const ideas = [
    idea({ id: 'a', status: 'under_review', category: 'meals' }),
    idea({ id: 'b', status: 'planned', category: 'calendar' }),
    idea({ id: 'c', status: 'shipped', category: 'meals' }),
  ];
  it('filters by status', () => {
    expect(filterIdeasForAdmin(ideas, { status: 'planned', category: 'all' }).map((i) => i.id)).toEqual(['b']);
  });
  it('filters by category', () => {
    expect(filterIdeasForAdmin(ideas, { status: 'all', category: 'meals' }).map((i) => i.id)).toEqual(['a', 'c']);
  });
  it('combines both', () => {
    expect(filterIdeasForAdmin(ideas, { status: 'shipped', category: 'meals' }).map((i) => i.id)).toEqual(['c']);
  });
  it('all/all returns everything', () => {
    expect(filterIdeasForAdmin(ideas, { status: 'all', category: 'all' })).toHaveLength(3);
  });
});
