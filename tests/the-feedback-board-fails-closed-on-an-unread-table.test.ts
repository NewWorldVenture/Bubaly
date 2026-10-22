// The idea board does not present a failed read as an empty board, and an
// upvote is what the database says it is (U3).
//
// The page dropped both read errors: unread ideas rendered "No ideas match
// these filters" with every tally at 0, and unread votes drew every pill
// unpressed — so a tap on an idea the member HAD voted for ran the toggle
// action, which found the vote and removed it, while the card lit the pill up
// and added one to the count.
//
// The page is rendered for real against an in-memory database; the board is
// driven through its own handlers (tests/helpers/module-harness.tsx) with the
// vote action's real answer shape.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';

const io = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1', email: 'pat@example.invalid' }, memberships: [], active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1', display_name: 'Pat' }, family: { name: 'Rivera', timezone: 'UTC' } } }),
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => io.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => createElement('a', { ...props, href }, children) }));

const FeedbackPage = (await import('@/app/(app)/feedback/page')).default;
const t = (key: string) => translate(SOURCE_MESSAGES, key);
let db: InMemorySupabase;

const idea = (id: string, title: string, votes: number) => ({
  id, author_id: 'user-9', author_name: 'Sam', family_id: 'fam-2', title, problem: null, body: null, category: 'other', impact: 'helpful', audience: 'me',
  kind: 'idea', image_url: null, status: 'under_review', admin_note: null, vote_count: votes, comment_count: 0, pinned: false,
  github_issue_number: null, github_issue_url: null, github_state: null, github_synced_at: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
});
const page = async () => renderTranslated(await FeedbackPage());
const pill = (html: string) => html.match(/<button[^>]*class="flex h-16 w-14[^"]*"[^>]*>/)?.[0] ?? '';
const refused = (table: string) => withFaults(db, (name) => (name === table ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
  io.db = db;
  db.seed('feedback_ideas', [idea('idea-1', 'Dark mode', 5)]);
  db.seed('feedback_votes', [{ id: 'vote-1', idea_id: 'idea-1', user_id: 'user-1', created_at: '2026-10-02T00:00:00.000Z' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the idea board page', () => {
  it('renders the board with the member\'s vote pressed when both reads answer', async () => {
    const html = await page();
    expect(html).toContain('Dark mode');
    expect(pill(html)).toContain('aria-pressed="true"');
    expect(pill(html)).not.toContain('disabled=""');
    expect(html).not.toContain(t('feedbackFeedbackBoard.yourVotesCouldNotBeRead'));
  });

  it('an unread ideas table is an error with a way back, not "No ideas match these filters"', async () => {
    io.db = refused('feedback_ideas');
    const html = await page();
    expect(html).toContain(t('feedback.couldNotLoadTheBoard'));
    expect(html).toContain(t('root.tryAgain'));
    expect(html).not.toContain(t('feedbackFeedbackBoard.noIdeasMatchTheseFilters'));
    expect(html).not.toContain(t('feedback.statusLegend'));
  });

  it('unread votes pause voting and say so, instead of drawing every pill unpressed', async () => {
    io.db = refused('feedback_votes');
    const html = await page();
    expect(html).toContain('Dark mode');
    expect(html).toContain(t('feedbackFeedbackBoard.yourVotesCouldNotBeRead'));
    expect(pill(html)).toContain('disabled=""');
    expect(pill(html)).not.toContain('aria-pressed="false"');
  });
});
