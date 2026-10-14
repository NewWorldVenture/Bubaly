// Three defects on Group Voting (and one on the Decision Engine beside it),
// driven through the REAL modules against an in-memory database whose
// responses are capped at 1,000 rows like PostgREST's db-max-rows:
//
//   N10 — a vote landed on a poll another member had already CLOSED.
//   family_polls is not in the realtime publication, so a page opened before
//   the Close still read 'open', and nothing in the database refused the
//   insert: the tally and the winner of a closed poll changed.
//
//   N12 — a poll's "closes" deadline was read in the DEVICE's zone
//   (`new Date(value)`), not the family's: a New York family's 8:00 PM set
//   from a phone in Los Angeles closed at 11:00 PM Eastern.
//
//   N13 — the options and votes were read for the whole family in one unpaged,
//   unordered query. Past 1,000 rows the server answered an arbitrary 1,000
//   with no error, so the newest poll could lose its options and votes: the
//   tally, "N voted", the consensus — and the member's own vote, so tapping it
//   inserted a duplicate instead of taking it back. decision_options was read
//   the same way and scored a decision on whichever options arrived.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, form, has, nodes, render, settle, submit, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).fetchedQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/why-this', () => ({ WhyThis: () => null }));

const { VotingModule } = await import('@/components/modules/voting-module');
const { DecisionsModule } = await import('@/components/modules/decisions-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
const ME = 'member-1';
let db: InMemorySupabase;

const poll = (id: string, question: string, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, question, description: null, kind: 'multi', status: 'open', closes_at: null, vacation_id: null,
  decision_category: 'general', budget_cents: null, required_tags: [], created_by: 'user-1', created_at: '2026-10-01T00:00:00Z', ...extra,
});
const option = (id: string, pollId: string, label: string) => ({ id, family_id: FAMILY, poll_id: pollId, label, sort: 0, cost_cents: null, travel_minutes: null, tags: [] });
const pad = (n: number) => String(n).padStart(6, '0');

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: 1000, uniques: { family_poll_votes: [['option_id', 'member_id']] } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Render until every read the module started has answered. */
async function screen(Component: () => ReactNode): Promise<ReactNode> {
  let tree = render(h.hooks, createElement(Component));
  for (let i = 0; i < 6; i++) { await settle(); tree = render(h.hooks, createElement(Component)); }
  return tree;
}
/** The card of one poll: the bordered block whose text holds its question. */
function pollCard(tree: ReactNode, question: string): Node {
  const card = nodes(tree).find((n) => n.type === 'div' && String(n.props.className).startsWith('rounded-2xl border border-border bg-surface/40 p-4') && has(n.props.children as ReactNode, question));
  expect(card, `the "${question}" poll is on screen`).toBeDefined();
  return card!;
}
const optionButton = (card: Node, label: string) => {
  const button = nodes(card.props.children as ReactNode).find((n) => n.type === 'button' && text(n).includes(label));
  expect(button, `"${label}" is offered`).toBeDefined();
  return button!;
};

describe('N10: a poll closed elsewhere takes no more votes', () => {
  it('a tap on a poll the screen still shows open, but the database has closed, writes nothing', async () => {
    db.seed('family_polls', [poll('poll-1', 'Pizza or tacos?')]);
    db.seed('family_poll_options', [option('opt-1', 'poll-1', 'Pizza'), option('opt-2', 'poll-1', 'Tacos')]);
    const tree = await screen(VotingModule);
    // A parent presses Close on another phone. family_polls is not published,
    // so this page is not told.
    db.table('family_polls')[0].status = 'closed';

    await click(optionButton(pollCard(tree, 'Pizza or tacos?'), 'Pizza'));

    expect(db.table('family_poll_votes')).toEqual([]);
    expect(h.toasts.error).toContain(t('votingModule.thisPollIsClosed'));
  });

  it('a poll still open takes the vote', async () => {
    db.seed('family_polls', [poll('poll-1', 'Pizza or tacos?')]);
    db.seed('family_poll_options', [option('opt-1', 'poll-1', 'Pizza'), option('opt-2', 'poll-1', 'Tacos')]);

    await click(optionButton(pollCard(await screen(VotingModule), 'Pizza or tacos?'), 'Pizza'));

    expect(db.table('family_poll_votes')).toMatchObject([{ poll_id: 'poll-1', option_id: 'opt-1', member_id: ME }]);
  });
});

describe('N12: a poll\'s deadline is on the family\'s clock', () => {
  it('8:00 PM typed for a New York family closes at 8:00 PM Eastern, whatever zone the device is in', async () => {
    h.timeZone = 'America/New_York';
    await click(byName(await screen(VotingModule), t('voting.newPoll'), 'button'));
    let tree = render(h.hooks, createElement(VotingModule));
    change(nodes(form(tree)).find((n) => n.props.placeholder === t('voting.whereShouldWeGoThisSummer')) as Node, 'Where this summer?');
    tree = render(h.hooks, createElement(VotingModule));
    change(nodes(form(tree)).find((n) => n.props.placeholder === t('voting.optionN').replace('{n}', '1')) as Node, 'Beach');
    tree = render(h.hooks, createElement(VotingModule));
    change(nodes(form(tree)).find((n) => n.props.placeholder === t('voting.optionN').replace('{n}', '2')) as Node, 'Mountains');
    tree = render(h.hooks, createElement(VotingModule));
    change(nodes(form(tree)).find((n) => n.props.type === 'datetime-local') as Node, '2026-10-13T20:00');

    await submit(form(render(h.hooks, createElement(VotingModule))));

    expect(db.table('family_polls')).toHaveLength(1);
    // 20:00 EDT is 00:00 UTC the next day.
    expect(new Date(db.table('family_polls')[0].closes_at as string).toISOString()).toBe('2026-10-14T00:00:00.000Z');
  });
});

describe('N13: every vote and option is counted, however long the family\'s history', () => {
  beforeEach(() => {
    // An old poll with 1,050 options and a vote on each, written first, so a
    // read cut at 1,000 rows is cut before it reaches the newest poll.
    db.seed('family_polls', [poll('poll-old', 'Old question', { created_at: '2025-01-01T00:00:00Z' })]);
    db.seed('family_poll_options', Array.from({ length: 1050 }, (_, i) => option(`o-old-${pad(i)}`, 'poll-old', `Old choice ${i}`)));
    db.seed('family_poll_votes', Array.from({ length: 1050 }, (_, i) => ({ id: `v-old-${pad(i)}`, family_id: FAMILY, poll_id: 'poll-old', option_id: `o-old-${pad(i)}`, member_id: 'member-old' })));
    db.seed('family_polls', [poll('poll-new', 'Movie night pick?', { created_at: '2026-10-12T00:00:00Z' })]);
    db.seed('family_poll_options', [option('o-new-a', 'poll-new', 'Space film'), option('o-new-b', 'poll-new', 'Cartoon')]);
    db.seed('family_poll_votes', [
      { id: 'v-new-1', family_id: FAMILY, poll_id: 'poll-new', option_id: 'o-new-a', member_id: ME },
      { id: 'v-new-2', family_id: FAMILY, poll_id: 'poll-new', option_id: 'o-new-a', member_id: 'member-2' },
    ]);
  });

  it('the newest poll shows its options and both its voters', async () => {
    const card = pollCard(await screen(VotingModule), 'Movie night pick?');
    expect(text(card)).toContain('2 voted');
    expect(text(optionButton(card, 'Space film'))).toContain('2 · 100%');
  });

  it('tapping your own vote takes it back, instead of trying to cast it again', async () => {
    await click(optionButton(pollCard(await screen(VotingModule), 'Movie night pick?'), 'Space film'));

    expect(db.table('family_poll_votes').filter((v) => v.poll_id === 'poll-new').map((v) => v.member_id)).toEqual(['member-2']);
  });

  it('a decision is scored on all of its options', async () => {
    db.seed('family_decisions', [{ id: 'dec-old', family_id: FAMILY, question: 'Old decision', status: 'open', decided_option_id: null, budget_cents: null, max_travel_minutes: null, weights: {}, created_by: 'user-1', updated_at: '2025-01-01T00:00:00Z' }]);
    db.seed('decision_options', Array.from({ length: 1050 }, (_, i) => ({ id: `d-old-${pad(i)}`, family_id: FAMILY, decision_id: 'dec-old', label: `Old option ${i}`, cost_cents: null, time_minutes: null, travel_minutes: null, load_delta: null, benefit: null, score: null, rationale: null, feasible: true })));
    db.seed('family_decisions', [{ id: 'dec-new', family_id: FAMILY, question: 'Saturday activity', status: 'open', decided_option_id: null, budget_cents: null, max_travel_minutes: null, weights: {}, created_by: 'user-1', updated_at: '2026-10-12T00:00:00Z' }]);
    db.seed('decision_options', [
      { id: 'd-new-a', family_id: FAMILY, decision_id: 'dec-new', label: 'Zoo trip', cost_cents: 4000, time_minutes: 240, travel_minutes: 30, load_delta: null, benefit: 4, score: null, rationale: null, feasible: true },
      { id: 'd-new-b', family_id: FAMILY, decision_id: 'dec-new', label: 'Board games', cost_cents: 0, time_minutes: 120, travel_minutes: 0, load_delta: null, benefit: 3, score: null, rationale: null, feasible: true },
    ]);

    const tree = await screen(DecisionsModule);
    expect(has(tree, 'Zoo trip')).toBe(true);
    expect(has(tree, 'Board games')).toBe(true);
  });
});
