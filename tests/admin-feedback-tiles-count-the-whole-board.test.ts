import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { has, nodes, render, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { resolveServerChildren } from './helpers/render-server-page';

// /admin/feedback read its ideas with `.limit(1000)`, and the console tallied
// every figure in its header from that list: Needs review, Active, Shipped,
// Total ideas, Total votes and the count on each status chip. Past 1,000 ideas
// PostgREST cut the list without saying so, and those figures quietly became
// the listed ideas' totals (review R7B-FEEDBACK-IDEAS-LIMIT-FEEDS-SUMMED-TILES).
// They count the board now: head:true counts of every idea and of each
// status, and every idea's votes added up, paged on the id to a ceiling past
// which Total votes alone says it is not shown and the ceiling banner names it.
// The list is as it was, and a read that FAILS is still the read-error state.
//
// The REAL page and the REAL console component (its hooks as slots), against
// the in-memory database with PostgREST's 1,000-row cap.
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
const VOTE_CEILING = 25_000;
const pad = (i: number) => String(i).padStart(6, '0');
let db: InMemorySupabase;

const idea = (k: number, status: string, votes: number): Row => ({
  id: `idea-${pad(k)}`, title: `Idea ${k}`, problem: null, body: null, category: 'feature', impact: 'helpful', audience: 'me',
  kind: 'idea', status, admin_note: null, image_url: null, author_name: 'A parent', vote_count: votes, comment_count: 0,
  pinned: false, github_issue_number: null, github_issue_url: null,
  // Higher k is newer, so the list (newest first) is the highest thousand.
  created_at: new Date(Date.UTC(2025, 0, 1) + k * 60_000).toISOString(),
});

/** The console as the page returns it, with every component called. */
async function open(): Promise<ReactNode> {
  const { default: AdminFeedbackPage } = await import('@/app/(app)/admin/feedback/page');
  return render(h.hooks, (await resolveServerChildren(await AdminFeedbackPage())) as ReactElement);
}

/** The figure a header tile shows above `label`. */
function tile(tree: ReactNode, label: string): string {
  const card = nodes(tree).find((n) => {
    const children = n.props.children;
    return n.type === 'div' && Array.isArray(children) && children.length === 2
      && (children[1] as Node).props?.className === 'mt-0.5 text-xs text-muted' && text(children[1] as Node) === label;
  });
  if (!card) throw new Error(`the "${label}" tile is not on the page`);
  return text((card.props.children as Node[])[0]);
}

/** The count a status filter chip shows beside its label. */
function chip(tree: ReactNode, label: string): string {
  for (const n of nodes(tree)) {
    if (n.type !== 'button') continue;
    const match = new RegExp(`^${label}(\\d+)$`).exec(text(n).trim());
    if (match) return match[1];
  }
  throw new Error(`the "${label}" chip is not on the page`);
}

const readError = () => SOURCE_MESSAGES['feedback.couldNotLoadFeedbackFrom'];
const notShownTitle = () => translate(SOURCE_MESSAGES, 'adminCeiling.figuresNotShown', { n: VOTE_CEILING.toLocaleString() });
const totalVotes = () => SOURCE_MESSAGES['feedbackAdmin.totalVotes'];
/** The cards the list draws: one pin control each. */
const listed = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'button' && n.props.title === 'Pin to top').length;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  h.toasts = { success: [], error: [] };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/admin/feedback past 1,000 ideas', () => {
  // The newest thousand are still being worked on; the 337 before them are
  // the shipped and declined ones, with most of the votes. A tally of the list
  // would show no Shipped at all and under a quarter of the votes.
  const UNDER_REVIEW = 500;
  const PLANNED = 300;
  const IN_PROGRESS = 200;
  const SHIPPED = 300;
  const DECLINED = 37;
  const TOTAL = UNDER_REVIEW + PLANNED + IN_PROGRESS + SHIPPED + DECLINED;
  const VOTES = (UNDER_REVIEW + PLANNED + IN_PROGRESS) * 1 + SHIPPED * 10 + DECLINED * 2;

  function seedPastTheCap() {
    let k = 0;
    const take = (n: number, status: string, votes: number) => Array.from({ length: n }, () => idea(k++, status, votes));
    const rows = [
      ...take(SHIPPED, 'shipped', 10),
      ...take(DECLINED, 'declined', 2),
      ...take(UNDER_REVIEW, 'under_review', 1),
      ...take(PLANNED, 'planned', 1),
      ...take(IN_PROGRESS, 'in_progress', 1),
    ];
    expect(rows).toHaveLength(TOTAL);
    db.seed('feedback_ideas', rows);
    db.seed('feedback_comments', []);
    db.seed('admin_notifications', []);
  }

  it('every tile and status chip counts every idea, not the thousand listed, and nothing is said to be missing', async () => {
    seedPastTheCap();
    const tree = await open();
    expect(has(tree, readError())).toBe(false);

    expect(tile(tree, 'Needs review')).toBe(String(UNDER_REVIEW));
    expect(tile(tree, 'Active')).toBe(String(PLANNED + IN_PROGRESS));
    expect(tile(tree, 'Shipped')).toBe(String(SHIPPED));
    expect(tile(tree, 'Total ideas')).toBe(String(TOTAL));
    expect(tile(tree, totalVotes())).toBe(String(VOTES));

    expect(chip(tree, 'Under review')).toBe(String(UNDER_REVIEW));
    expect(chip(tree, 'Planned')).toBe(String(PLANNED));
    expect(chip(tree, 'In progress')).toBe(String(IN_PROGRESS));
    expect(chip(tree, 'Shipped')).toBe(String(SHIPPED));
    expect(chip(tree, 'Not planned')).toBe(String(DECLINED));

    // The list is as it was: the newest thousand, newest first.
    expect(listed(tree)).toBe(CAP);
    expect(has(tree, `Idea ${TOTAL - 1}`)).toBe(true);
    expect(has(tree, `Idea ${TOTAL - CAP - 1}`)).toBe(false);
    expect(has(tree, notShownTitle())).toBe(false);
  });

  it('past 25,000 ideas Total votes alone says it is not shown, and the ceiling banner names it', async () => {
    db.seed('feedback_ideas', Array.from({ length: VOTE_CEILING + 1 }, (_, k) => idea(k, k % 2 ? 'planned' : 'shipped', 3)));
    db.seed('feedback_comments', []);
    db.seed('admin_notifications', []);
    const tree = await open();
    expect(has(tree, readError())).toBe(false);

    expect(tile(tree, totalVotes())).toBe(SOURCE_MESSAGES['strategyMetrics.unavailable']);
    const banner = nodes(tree).find((n) => n.props.role === 'status' && has(n, notShownTitle()));
    expect(banner, 'the ceiling banner').toBeDefined();
    expect(nodes(banner).filter((n) => n.type === 'li').map((n) => text(n))).toEqual([totalVotes()]);

    // The counts need no row, so they are exact past the ceiling.
    expect(tile(tree, 'Total ideas')).toBe(String(VOTE_CEILING + 1));
    expect(tile(tree, 'Shipped')).toBe(String(VOTE_CEILING / 2 + 1));
    expect(tile(tree, 'Active')).toBe(String(VOTE_CEILING / 2));
    expect(listed(tree)).toBe(CAP);
  });

  // Each of the board's new reads, told apart by its calls.
  const READS: [string, (calls: FaultCall[]) => boolean][] = [
    ['the count of every idea', (calls) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true)
      && !calls.some((c) => c.method === 'eq')],
    ['one status\'s count, shipped', (calls) => calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'shipped')],
    ['the votes, on their first page', (calls) => calls.some((c) => c.method === 'select' && c.args[0] === 'id, vote_count')
      && !calls.some((c) => c.method === 'gt')],
    ['the votes, on a later page', (calls) => calls.some((c) => c.method === 'select' && c.args[0] === 'id, vote_count')
      && calls.some((c) => c.method === 'gt')],
  ];

  it.each(READS)('a read that FAILS (%s) is still the read-error state', async (_, failing) => {
    seedPastTheCap();
    let faulted = 0;
    h.db = withFaults(db, (table, calls) => {
      if (table !== 'feedback_ideas' || !failing(calls)) return null;
      faulted += 1;
      return { message: 'feedback_ideas unavailable' };
    });
    const tree = await open();
    expect(faulted).toBe(1);
    expect(has(tree, readError())).toBe(true);
    expect(has(tree, 'Total ideas')).toBe(false);
    expect(has(tree, `Idea ${TOTAL - 1}`)).toBe(false);
  });
});
