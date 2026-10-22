// An upvote pill shows what the vote action ANSWERED, not the opposite of what
// the card believed (U3).
//
// `toggleVoteAction` re-reads the database: it removes a vote that exists and
// adds one that does not, and answers `voted` and the idea's `count`. The card
// ignored both and toggled its own copy, so a pill drawn from a stale or unread
// vote list (every pill unpressed after a failed votes read) lit up and added
// one while the database had just removed the member's vote.
//
// The real FeedbackBoard, driven through its own handlers
// (tests/helpers/module-harness.tsx); only the server action is replaced.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, nodes, render, settle, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const action = vi.hoisted(() => ({ answer: { ok: true, voted: false, count: 4 } as { ok: boolean; voted?: boolean; count?: number; error?: string }, calls: 0 }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/app/(app)/feedback/feedback-attachment-upload', () => ({ FeedbackAttachmentUpload: () => null }));
vi.mock('@/app/(app)/feedback/actions', () => ({
  toggleVoteAction: async () => { action.calls += 1; return action.answer; },
  submitIdeaAction: async () => ({ ok: false, error: 'not in this test' }),
  addCommentAction: async () => ({ ok: false, error: 'not in this test' }),
  setIdeaStatusAction: async () => ({ ok: false, error: 'not in this test' }),
}));

const { FeedbackBoard } = await import('@/app/(app)/feedback/feedback-board');

const idea = {
  id: 'idea-1', title: 'Dark mode', problem: null, body: null, category: 'other', impact: 'helpful', audience: 'me', kind: 'idea',
  status: 'under_review', admin_note: null, image_url: null, author_name: 'Sam', vote_count: 5, comment_count: 0, pinned: false, created_at: '2026-10-01T00:00:00.000Z',
};
const board = (votedIds: string[]) => createElement(FeedbackBoard, { initialIdeas: [idea], votedIds, userId: 'user-1', isSuperAdmin: false });
const pillOf = (tree: ReturnType<typeof render>) => nodes(tree).find((n) => n.type === 'button' && String(n.props.className ?? '').includes('h-16 w-14'))!;

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  action.calls = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('tapping the upvote pill', () => {
  it('a vote the database REMOVED leaves the pill unpressed at the database\'s count, even from a stale list', async () => {
    // The screen believes the member has not voted; the database holds their vote.
    action.answer = { ok: true, voted: false, count: 4 };
    let tree = render(h.hooks, board([]));
    expect(pillOf(tree).props['aria-pressed']).toBe(false);
    expect(text(pillOf(tree))).toContain('5');
    await click(pillOf(tree));
    await settle();
    tree = render(h.hooks, board([]));
    expect(action.calls).toBe(1);
    expect(pillOf(tree).props['aria-pressed']).toBe(false);
    expect(text(pillOf(tree))).toContain('4');
  });

  it('a vote the database ADDED presses the pill at the database\'s count', async () => {
    action.answer = { ok: true, voted: true, count: 6 };
    let tree = render(h.hooks, board([]));
    await click(pillOf(tree));
    await settle();
    tree = render(h.hooks, board([]));
    expect(pillOf(tree).props['aria-pressed']).toBe(true);
    expect(text(pillOf(tree))).toContain('6');
  });

  it('a refused vote changes nothing on the card and is said', async () => {
    action.answer = { ok: false, error: 'Could not save the vote.' };
    let tree = render(h.hooks, board([]));
    await click(pillOf(tree));
    await settle();
    tree = render(h.hooks, board([]));
    expect(pillOf(tree).props['aria-pressed']).toBe(false);
    expect(text(pillOf(tree))).toContain('5');
    expect(h.toasts.error).toEqual(['Could not save the vote.']);
  });
});
