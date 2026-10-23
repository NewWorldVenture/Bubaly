import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { allByName, click, has, nodes, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { resolveServerChildren } from './helpers/render-server-page';

// /admin/feedback read every comment on the board, paged to a 3,000-row
// ceiling with reaching it an error that joined the page's read error. So past
// 3,000 comments the console was the read-error state: the ideas list, every
// moderation form (status, roadmap note, pin, reply, remove) and the activity
// relay went with it, though none of them needs a comment row (review
// R6-FEEDBACK-COMMENT-CEILING-TAKES-THE-IDEAS). Now the ceiling costs the
// threads alone, and each says it is not shown; a comment read that FAILS is
// still the read-error state.
//
// The REAL page and the REAL console component (its hooks as slots, so the
// "Act on this idea" toggle opens a card), against the in-memory database.
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return { default: ({ children, href, ...props }: { children?: ReactNode; href: string }) => createElement('a', { href, ...props }, children) };
});
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('@/lib/integrations/github', () => ({ githubRepoStatus: async () => ({ ok: false, repo: '', detail: 'not set' }) }));
vi.mock('@/app/(app)/admin/feedback/actions', () => ({
  updateIdeaAction: async () => ({ ok: true }), setIdeaPinnedAction: async () => ({ ok: true }),
  deleteIdeaAction: async () => ({ ok: true }), postTeamReplyAction: async () => ({ ok: true }),
  syncGithubNowAction: async () => ({ ok: true, summary: '' }), markAdminNotificationsReadAction: async () => ({ ok: true }),
}));

const CAP = 1000;
const CEILING = 3000;
const pad = (i: number) => String(i).padStart(6, '0');
let db: InMemorySupabase;

const idea = (id: string, title: string, comments: number, createdAt: string): Row => ({
  id, title, problem: null, body: `${title}, please`, category: 'feature', impact: null, audience: null, kind: 'idea',
  status: 'under_review', admin_note: null, image_url: null, author_name: 'A parent', vote_count: 3,
  comment_count: comments, pinned: false, github_issue_number: null, github_issue_url: null, created_at: createdAt,
});
/** `n` comments on `ideaId`, oldest first, numbered from `first`. */
const comments = (ideaId: string, n: number, first = 0): Row[] => Array.from({ length: n }, (_, k) => ({
  id: `c-${ideaId}-${pad(first + k)}`, idea_id: ideaId, author_name: 'A member', is_team: false,
  body: `${ideaId} comment ${first + k}`, created_at: new Date(Date.UTC(2026, 8, 1) + (first + k) * 60_000).toISOString(),
}));

function seedBoard(darkModeComments: number, offlineComments: number) {
  db.seed('feedback_ideas', [
    idea('dark', 'Dark mode', darkModeComments, '2026-10-02T00:00:00Z'),
    idea('offline', 'Offline mode', offlineComments, '2026-10-01T00:00:00Z'),
  ]);
  db.seed('feedback_comments', [...comments('dark', darkModeComments), ...comments('offline', offlineComments)]);
  db.seed('admin_notifications', [
    { id: 'note-1', kind: 'feedback', title: 'New idea: Dark mode', body: null, url: null, is_read: false, created_at: '2026-10-02T00:00:00Z' },
  ]);
}

/** The console as the page returns it, with every component called. */
async function open(): Promise<ReactElement> {
  const { default: AdminFeedbackPage } = await import('@/app/(app)/admin/feedback/page');
  return (await resolveServerChildren(await AdminFeedbackPage())) as ReactElement;
}

/** Open the card of the idea listed `index`th (newest first) and render again. */
async function expandIdea(page: ReactElement, index: number): Promise<ReactNode> {
  const toggles = allByName(render(h.hooks, page), /^Act on this idea/, 'button');
  await click(toggles[index]);
  return render(h.hooks, page);
}

const readError = () => SOURCE_MESSAGES['feedback.couldNotLoadFeedbackFrom'];
const notShown = () => SOURCE_MESSAGES['feedbackAdmin.conversationNotShown'];

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  h.toasts = { success: [], error: [] };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/admin/feedback past 3,000 comments', () => {
  it('lists every idea with its moderation forms and the relay; the thread alone says it is not shown', async () => {
    seedBoard(1800, CEILING + 1 - 1800);
    const page = await open();
    const tree = render(h.hooks, page);
    expect(has(tree, readError())).toBe(false);
    expect(has(tree, 'Dark mode')).toBe(true);
    expect(has(tree, 'Offline mode')).toBe(true);
    expect(has(tree, 'New idea: Dark mode')).toBe(true);
    // Pin and remove sit on every card.
    expect(nodes(tree).filter((n) => n.type === 'button' && n.props.title === 'Pin to top')).toHaveLength(2);
    expect(nodes(tree).filter((n) => n.type === 'button' && n.props.title === SOURCE_MESSAGES['feedbackAdmin.deleteIdea'])).toHaveLength(2);

    const card = await expandIdea(page, 0);
    // Status, roadmap note and reply are there to act on the idea.
    expect(nodes(card).some((n) => n.type === 'select' && n.props.id !== undefined)).toBe(true);
    expect(nodes(card).some((n) => n.type === 'textarea' && n.props.placeholder === SOURCE_MESSAGES['feedbackAdmin.replyAsTheBubalyTeam'])).toBe(true);
    expect(has(card, SOURCE_MESSAGES['feedbackAdmin.saveStatusAmpNote'])).toBe(true);
    // The thread says it is not shown, rather than showing a part of it as the whole.
    expect(has(card, notShown())).toBe(true);
    expect(has(card, SOURCE_MESSAGES['feedbackAdmin.conversation'])).toBe(false);
    expect(has(card, 'dark comment 0')).toBe(false);
  });

  it('a comment read that FAILS is still the read-error state', async () => {
    seedBoard(1800, CEILING + 1 - 1800);
    h.db = withFaults(db, (table) => (table === 'feedback_comments' ? { message: 'feedback_comments unavailable' } : null));
    const tree = render(h.hooks, await open());
    expect(has(tree, readError())).toBe(true);
    expect(has(tree, 'Dark mode')).toBe(false);
  });

  it('the control: under the ceiling every comment of a thread is shown, past the first thousand, and nothing is said to be missing', async () => {
    seedBoard(CAP + 300, 5);
    const page = await open();
    const card = await expandIdea(page, 0);
    expect(has(card, readError())).toBe(false);
    expect(has(card, notShown())).toBe(false);
    expect(has(card, SOURCE_MESSAGES['feedbackAdmin.conversation'])).toBe(true);
    expect(has(card, 'dark comment 0')).toBe(true);
    expect(has(card, `dark comment ${CAP + 299}`)).toBe(true);
    expect(has(card, 'offline comment 0')).toBe(false);
  });
});
