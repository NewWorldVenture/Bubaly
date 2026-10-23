// The member idea board's rail ("On the board", the status legend) counted
// the listed ideas, which are the top 400 at most, so past 400 ideas every
// figure there was a total of the listed ones with nothing to say so (review
// R8B-PUBLIC-BOARD-TALLIES-FROM-LIMIT-400). They are head:true counts of the
// whole board now, a count that fails reads Unavailable, and the list says
// when it holds only part of the board.
//
// The REAL page, rendered against the in-memory database with PostgREST's
// 1,000-row cap.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { KIND_META, STATUS_META, type FeedbackKind, type FeedbackStatus } from '@/lib/feedback/board';

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
const CAP = 1000;
const pad = (i: number) => String(i).padStart(6, '0');
let db: InMemorySupabase;

const idea = (k: number, kind: FeedbackKind, status: FeedbackStatus, votes: number) => ({
  id: `idea-${pad(k)}`, author_id: 'user-9', author_name: 'Sam', family_id: 'fam-2', title: `Idea ${k}`, problem: null, body: null,
  category: 'other', impact: 'helpful', audience: 'me', kind, image_url: null, status, admin_note: null, vote_count: votes,
  comment_count: 0, pinned: false, github_issue_number: null, github_issue_url: null, github_state: null, github_synced_at: null,
  created_at: new Date(Date.UTC(2026, 0, 1) + k * 60_000).toISOString(), updated_at: '2026-10-01T00:00:00.000Z',
});
const page = async () => renderTranslated(await FeedbackPage());

/** The figure the rail shows beside a kind's or a status's label. */
const kindFigure = (html: string, kind: FeedbackKind) =>
  new RegExp(`${KIND_META[kind].emoji} ${KIND_META[kind].label}</span><span class="text-\\[11px\\] font-semibold text-muted tabular-nums">([^<]*)</span>`).exec(html)?.[1];
const statusFigure = (html: string, status: FeedbackStatus) =>
  new RegExp(`</span>${STATUS_META[status].label}</span><span class="text-\\[11px\\] font-semibold text-muted tabular-nums">([^<]*)</span>`).exec(html)?.[1];
const partOfTheBoard = (shown: number, total: number) =>
  translate(SOURCE_MESSAGES, 'feedbackFeedbackBoard.theBoardListsTheTop', { shown: shown.toLocaleString(), total: total.toLocaleString() });
const listed = (html: string) => (html.match(/>Idea \d+<\/h3>/g) ?? []).length;
const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];

/**
 * 400 under-review ideas with votes, the top of the board, and 50 shipped bug
 * reports with none, below them: the 400 listed hold no bug and nothing shipped.
 */
function seedPastTheList() {
  db.seed('feedback_ideas', [
    ...Array.from({ length: 50 }, (_, k) => idea(k, 'bug', 'shipped', 0)),
    ...Array.from({ length: 400 }, (_, k) => idea(50 + k, 'idea', 'under_review', 5)),
  ]);
  db.seed('feedback_votes', []);
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({ maxRows: CAP });
  io.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the idea board past the 400 ideas it lists', () => {
  it('"On the board" and the status legend count every idea, and the list says it is part of the board', async () => {
    seedPastTheList();
    const html = await page();
    expect(html).not.toContain(SOURCE_MESSAGES['feedback.couldNotLoadTheBoard']);
    expect(listed(html)).toBe(400);
    expect(kindFigure(html, 'idea')).toBe('400');
    expect(kindFigure(html, 'bug')).toBe('50');
    expect(statusFigure(html, 'under_review')).toBe('400');
    expect(statusFigure(html, 'shipped')).toBe('50');
    expect(statusFigure(html, 'planned')).toBe('0');
    expect(html).toContain(partOfTheBoard(400, 450));
  });

  it('the control: a board that fits the list is counted the same, and says nothing about part of it', async () => {
    db.seed('feedback_ideas', [
      ...Array.from({ length: 3 }, (_, k) => idea(k, 'bug', 'shipped', 0)),
      ...Array.from({ length: 7 }, (_, k) => idea(3 + k, 'idea', 'planned', 2)),
    ]);
    db.seed('feedback_votes', []);
    const html = await page();
    expect(listed(html)).toBe(10);
    expect(kindFigure(html, 'idea')).toBe('7');
    expect(kindFigure(html, 'bug')).toBe('3');
    expect(statusFigure(html, 'planned')).toBe('7');
    expect(statusFigure(html, 'shipped')).toBe('3');
    expect(html).not.toContain(partOfTheBoard(10, 10).slice(0, 14));
    expect(html).not.toContain(unavailable);
  });

  const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);
  it.each([
    ['one status\'s count, shipped', (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'shipped'), 'shipped'],
    ['one kind\'s count, bug reports', (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[0] === 'kind' && c.args[1] === 'bug'), 'bug'],
  ] as const)('a count that FAILS (%s) reads Unavailable, not a tally of the list; the board stays', async (_, failing, which) => {
    seedPastTheList();
    let faulted = 0;
    io.db = withFaults(db, (table, calls) => {
      if (table !== 'feedback_ideas' || !failing(calls)) return null;
      faulted += 1;
      return { message: 'feedback_ideas unavailable' };
    });
    const html = await page();
    expect(faulted).toBe(1);
    expect(listed(html)).toBe(400);
    if (which === 'shipped') {
      expect(statusFigure(html, 'shipped')).toBe(unavailable);
      expect(kindFigure(html, 'bug')).toBe('50');
    } else {
      expect(kindFigure(html, 'bug')).toBe(unavailable);
      expect(statusFigure(html, 'shipped')).toBe('50');
    }
    expect(statusFigure(html, 'under_review')).toBe('400');
  });

  it('a total count that FAILS does not say how much of the board is listed', async () => {
    seedPastTheList();
    io.db = withFaults(db, (table, calls) => (table === 'feedback_ideas' && head(calls) && !calls.some((c) => c.method === 'eq') ? { message: 'feedback_ideas unavailable' } : null));
    const html = await page();
    expect(listed(html)).toBe(400);
    expect(html).not.toContain(partOfTheBoard(400, 450).slice(0, 14));
    expect(kindFigure(html, 'bug')).toBe('50');
  });
});
