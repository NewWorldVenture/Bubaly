// The assistant workspace (§54) and the card components (§53), server-rendered
// the way Next renders client components on first paint. A throw here is the
// route error boundary in production, so every kind is rendered in both
// layouts with the awkward shapes the engine can actually produce, and the
// pure grouping/labelling helpers the module relies on get real unit tests.
// Layout invariants that only CSS expresses are pinned as a source contract.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  usePathname: () => '/dashboard/assistant',
}));
// The approval card's server actions reach the cookie session; the render
// test only needs them to exist.
vi.mock('@/app/(app)/dashboard/approvals-actions', () => ({
  decideApproval: vi.fn(),
  editAndApproveApproval: vi.fn(),
}));

import { ToastProvider } from '@/components/ui/toast';
import { CardSkeleton, CardError, ResultCardView } from '@/components/ai/cards';
import { cardFromRunDetail } from '@/components/ai/cards/run-status';
import { AssistantWorkspace, SegmentedControl, WORKSPACE_PANES, isWorkspacePane } from '@/components/assistant/workspace';
import { ResultPane, cardId, groupTurnCards, type ConversationMessage } from '@/components/assistant/result-pane';
import { ContextRail } from '@/components/assistant/context-rail';
import { ConversationPane } from '@/components/assistant/conversation-pane';
import { cardChipLabel, withRunCards } from '@/components/modules/assistant-module';
import { runStatusCard, type ResultCard } from '@/lib/ai/result-cards';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const render = (node: React.ReactElement) => renderToStaticMarkup(React.createElement(ToastProvider, null, node));

const CARDS: ResultCard[] = [
  { kind: 'meal_plan', title: '5 dinners planned', week_start: '2026-09-07', replaced: 1, created_meals: 2, href: '/dashboard/meals', days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-0${i + 1}`, label: `Day ${i + 1}`, meals: [{ meal_type: 'breakfast', name: 'Oats' }, { meal_type: 'dinner', name: i === 3 ? null : `Dish ${i + 1}` }] })) },
  { kind: 'calendar_conflict', title: '1 overlap', conflicts: [{ when: 'Saturday at 10:00 AM', titles: ['Soccer', 'Dentist'], member: 'Sam', event_ids: ['e1', 'e2'] }], href: '/dashboard/calendar' },
  { kind: 'calendar_conflict', title: 'All clear', conflicts: [] },
  { kind: 'budget_analysis', title: 'September budgets', currency: 'USD', period: '2026-09', total_spent: 950, total_limit: 900, insight: '1 budget is over.', rows: [{ label: 'Groceries', spent: 620, limit: 500, share: 124, delta: null, over: true }, { label: 'Fuel', spent: 330, limit: 400, share: 82, delta: null, over: false }] },
  { kind: 'budget_analysis', title: 'Spending vs last month', currency: 'USD', total_spent: 1250, total_limit: null, previous_total: 1200, rows: [{ label: 'Dining', spent: 300, limit: null, share: null, delta: 100, over: true }] },
  { kind: 'vacation_prep', title: 'Trip drafted', trip_id: 't1', destination: 'Lisbon', dates: '2026-10-01 – 2026-10-08', items: [{ label: '3 activities', detail: null, done: true }, { label: 'Soccer', detail: 'Saturday · Sam', done: false }], next_steps: ['Review the itinerary'], href: '/dashboard/vacations/t1' },
  { kind: 'task_group', title: '2 tasks', tasks: [{ id: 'a', title: 'Order forms', assignee: 'Dan', due: 'Friday', done: false }, { id: null, title: 'Dishes', assignee: null, due: null, done: true }], href: '/dashboard/todos' },
  { kind: 'grocery_list', title: '8 items added', list_id: 'l1', items: Array.from({ length: 8 }, (_, i) => ({ name: `Item ${i}`, quantity: i % 2 ? '2' : null, category: i < 4 ? 'Dairy' : null, checked: i === 7 })), skipped: ['Eggs'], in_pantry: ['Rice'] },
  { kind: 'readiness', title: 'Lisbon readiness', score: 72, level: 'mostly ready', days_until: 12, factors: [{ label: 'Documents', score: 40 }, { label: 'Packing', score: 90 }], recommendations: ['Renew Sam’s passport', 'Book the airport ride'], risks: [{ title: 'Passport expires', detail: 'Sam, in 3 months', severity: 3 }], href: '/dashboard/vacations/t1' },
  { kind: 'summary', title: 'Created chore “Dishes”', facts: [{ label: 'Points', value: '5' }, { label: 'Due', value: 'Saturday' }], items: ['Dishes'], note: null },
  { kind: 'approval', title: 'Add soccer Saturday', approval: { id: 'ap1', title: 'Add soccer Saturday', summary: 'Bubaly wants to add an event', consequences: ['Adds soccer to the calendar'], domain: 'calendar', requestedBy: 'Bubaly', requestedAt: '2026-09-05T10:00:00Z', expiresAt: '2099-01-01T00:00:00Z', runId: null, amountCents: 2500, canEdit: true, editableFields: [{ key: 'title', label: 'Title', value: 'Soccer', type: 'text' }] } },
  { kind: 'run_status', title: 'Bubaly is working on it', run_id: 'r1', status: 'executing', summary: 'Planning the week', steps_done: 1, steps_total: 4, href: '/dashboard/concierge/runs/r1' },
];

describe('result card components', () => {
  it('render every kind in both layouts without throwing, and never show a tool name', () => {
    for (const card of CARDS) {
      for (const compact of [false, true]) {
        const html = render(React.createElement(ResultCardView, { card, compact, canDecide: true, onAsk: () => undefined }));
        expect(html, `${card.kind} compact=${compact}`).toContain(card.title);
        expect(html).not.toMatch(/calendar\.createEvent|meals\.planWeek|tool_name/);
      }
    }
  });

  it('caps long lists in the compact layout and says how many were cut', () => {
    const full = render(React.createElement(ResultCardView, { card: CARDS[0], compact: false }));
    const compact = render(React.createElement(ResultCardView, { card: CARDS[0], compact: true }));
    expect(full).toContain('Day 7');
    expect(compact).not.toContain('Day 7');
    expect(compact).toContain('+3 more');
    // Compact shows dinners only; full shows every slot with its label.
    expect(full).toContain('Breakfast:');
    expect(compact).not.toContain('Breakfast:');
    // An open slot is said, not blank.
    expect(full).toContain('open');
  });

  it('links each card to its module and the run card to the run page', () => {
    expect(render(React.createElement(ResultCardView, { card: CARDS[0] }))).toContain('href="/dashboard/meals"');
    expect(render(React.createElement(ResultCardView, { card: CARDS[11] }))).toContain('href="/dashboard/concierge/runs/r1"');
    expect(render(React.createElement(ResultCardView, { card: CARDS[11] }))).toContain('1 of 4 steps');
  });

  it('states a clean conflict check as good news and an over budget as a warning', () => {
    expect(render(React.createElement(ResultCardView, { card: CARDS[2] }))).toContain('Nobody is double-booked.');
    const budget = render(React.createElement(ResultCardView, { card: CARDS[3] }));
    expect(budget).toContain('$950 of $900');
    expect(budget).toContain('$620 / $500');
    expect(render(React.createElement(ResultCardView, { card: CARDS[4] }))).toContain('$1,250 vs $1,200 before');
  });

  it('exposes the readiness score as a meter and lists the risks before the recommendations', () => {
    const html = render(React.createElement(ResultCardView, { card: CARDS[8] }));
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="72"');
    expect(html.indexOf('Passport expires')).toBeLessThan(html.indexOf('Renew Sam’s passport'));
    expect(html).toContain('12 days to go');
  });

  it('wraps the shared approval card with its buttons for a manager, and a waiting note otherwise', () => {
    const manager = render(React.createElement(ResultCardView, { card: CARDS[10], canDecide: true }));
    expect(manager).toContain('Approve');
    expect(manager).toContain('Decline');
    expect(manager).toContain('Adds soccer to the calendar');
    const child = render(React.createElement(ResultCardView, { card: CARDS[10], canDecide: false }));
    expect(child).toContain('Waiting for a parent or adult.');
    expect(child).not.toContain('aria-label="Approve');
  });

  it('has loading and error states', () => {
    expect(render(React.createElement(CardSkeleton, {}))).toContain('role="status"');
    const err = render(React.createElement(CardError, { message: 'Could not show that.', onRetry: () => undefined }));
    expect(err).toContain('role="alert"');
    expect(err).toContain('Try again');
  });

  it('reads a run detail response defensively', () => {
    const fallback = runStatusCard({ runId: 'r1', status: 'queued' });
    expect(cardFromRunDetail('r1', { run: { status: 'executing' }, plan: { reasoning_summary: 'Filling the week' }, steps: [{ status: 'completed' }, { status: 'skipped' }, { status: 'queued' }] }, fallback))
      .toMatchObject({ status: 'executing', summary: 'Filling the week', steps_done: 2, steps_total: 3, title: 'Bubaly is working on it' });
    expect(cardFromRunDetail('r1', null, fallback)).toMatchObject({ status: 'queued', steps_total: null });
    expect(cardFromRunDetail('r1', { run: { status: 'completed' }, steps: 'nope' }, fallback).status).toBe('completed');
  });
});

describe('workspace layout', () => {
  const panes = { conversation: React.createElement('p', null, 'CONVERSATION'), plan: React.createElement('p', null, 'PLAN'), context: React.createElement('p', null, 'CONTEXT') };

  it('is three columns on a desktop and a Chat | Plan | Context tablist below it', () => {
    const html = render(React.createElement(AssistantWorkspace, { pane: 'plan', onPaneChange: () => undefined, ...panes, counts: { plan: 2 } }));
    expect(html).toContain('lg:grid-cols-[320px_1fr_330px]');
    expect(html).toContain('role="tablist"');
    expect(WORKSPACE_PANES.map((p) => p.label)).toEqual(['Chat', 'Plan', 'Context']);
    // Only the active pane is visible on a phone; the others are hidden, not unmounted.
    expect(html).toMatch(/id="assistant-pane-chat"[^>]*hidden/);
    expect(html).not.toMatch(/id="assistant-pane-plan"[^>]*hidden/);
    expect(html).toMatch(/aria-selected="true"[^>]*>[^<]*<svg[^>]*>[\s\S]*?<\/svg>Plan/);
    expect(html).toContain('aria-label="2 new"');
    expect(isWorkspacePane('plan')).toBe(true);
    expect(isWorkspacePane('settings')).toBe(false);
  });

  it('puts the hero in the centre and on the Chat tab before a conversation exists', () => {
    const html = render(React.createElement(AssistantWorkspace, { pane: 'chat', onPaneChange: () => undefined, ...panes, hero: React.createElement('p', null, 'HERO') }));
    expect(html.match(/HERO/g)).toHaveLength(2);
    expect(html).toContain('CONVERSATION');
    expect(html).toContain('PLAN');
  });

  it('gives every tab a 44px touch target', () => {
    const html = render(React.createElement(SegmentedControl, { value: 'chat', onChange: () => undefined }));
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/coarse:min-h-11/g)).toHaveLength(3);
  });
});

describe('result pane', () => {
  const messages: ConversationMessage[] = [
    { id: 'u1', role: 'user', content: 'Plan dinners' },
    { id: 'a1', role: 'assistant', content: 'Done.', cards: [CARDS[0], CARDS[7]] },
    { id: 'u2', role: 'user', content: 'Any conflicts?' },
    { id: 'a2', role: 'assistant', content: 'One.', cards: [CARDS[1]] },
    { id: 'u3', role: 'user', content: 'Thanks' },
    { id: 'a3', role: 'assistant', content: 'Any time.' },
  ];

  it('groups cards by turn, newest first, under the prompt that produced them', () => {
    const groups = groupTurnCards(messages);
    expect(groups.map((g) => g.prompt)).toEqual(['Any conflicts?', 'Plan dinners']);
    expect(groups[1].cards.map((c) => c.id)).toEqual([cardId('a1', 0), cardId('a1', 1)]);
    expect(groupTurnCards([])).toEqual([]);
  });

  it('renders the groups, highlights the pointed-at card, and has empty / loading / error states', () => {
    const html = render(React.createElement(ResultPane, { messages, canDecide: false, highlightId: cardId('a2', 0) }));
    expect(html.indexOf('1 overlap')).toBeLessThan(html.indexOf('5 dinners planned'));
    expect(html).toMatch(/data-card-id="a2:0"[^>]*ring-2/);
    expect(render(React.createElement(ResultPane, { messages: [], canDecide: false }))).toContain('Nothing planned yet');
    expect(render(React.createElement(ResultPane, { messages: [{ id: 'u', role: 'user', content: 'x' }, { id: 'a', role: 'assistant', content: '' }], streaming: true, canDecide: false }))).toContain('role="status"');
    expect(render(React.createElement(ResultPane, { messages, canDecide: false, error: 'Could not open that conversation.' }))).toContain('Could not open that conversation.');
  });
});

describe('conversation pane and context rail', () => {
  it('lists conversations behind a disclosure with rename / delete targets, and states empty and error', () => {
    const base = { activeId: 'c1', onSelect: () => undefined, onNew: () => undefined, onRename: () => undefined, onDelete: () => undefined };
    const html = render(React.createElement(ConversationPane, { ...base, conversations: [{ id: 'c1', title: 'Weekend plans', updated_at: '' }, { id: 'c2', title: '', updated_at: '' }] }, React.createElement('p', null, 'THREAD')));
    expect(html).toContain('THREAD');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Rename: Weekend plans"');
    expect(html).toContain('aria-label="Delete: New conversation"');
    expect(html).toContain('aria-current="true"');
    expect(render(React.createElement(ConversationPane, { ...base, conversations: [] }))).toContain('No saved chats yet.');
    expect(render(React.createElement(ConversationPane, { ...base, conversations: [], error: 'Could not load your conversations.' }))).toContain('Could not load your conversations.');
  });

  it('shows skeletons while loading and a retryable error, and offers the prompts as buttons', () => {
    const Icon = () => React.createElement('i');
    const props = { glance: [{ icon: Icon, value: '3', label: 'Events today' }], upcoming: [], activity: [], prompts: [{ icon: Icon, text: 'Plan dinners for this week' }], onAsk: () => undefined };
    const loading = render(React.createElement(ContextRail, { ...props, loading: true }));
    expect(loading).toContain('aria-label="Loading"');
    const loaded = render(React.createElement(ContextRail, { ...props, error: 'Could not load today’s context.', onRetry: () => undefined }));
    expect(loaded).toContain('Could not load today’s context.');
    expect(loaded).toContain('Try again');
    expect(loaded).toContain('Plan dinners for this week');
    expect(loaded).toContain('Nothing coming up');
  });
});

describe('assistant module', () => {
  const src = read('components/modules/assistant-module.tsx');

  it('posts to the canonical /api/ai and never to the legacy chat route', () => {
    expect(src).toContain("fetch('/api/ai'");
    expect(src).not.toContain('/api/ai/chat');
  });

  it('parses the stream through the shared contract, renders cards through the pane, and rehydrates structured_content', () => {
    expect(src).toContain('parseAssistantStreamEvent(raw)');
    expect(src).toContain("ev.type === 'card'");
    expect(src).toContain("ev.type === 'run'");
    expect(src).toContain('structured_content');
    expect(src).toContain('structuredContentFrom(m.structured_content)');
    expect(src).toContain('<ResultPane');
    expect(src).toContain('<AssistantWorkspace');
    // The thread shows a tool result's summary, never its name (§35).
    expect(src).not.toMatch(/\{a\.name\}/);
    expect(src).not.toMatch(/\{ev\.name\}/);
  });

  it('labels outcome chips from what the card says, and turns stored run ids into run cards once', () => {
    expect(cardChipLabel(CARDS[0])).toBe('Meal plan · 7 days');
    expect(cardChipLabel(CARDS[1])).toBe('1 conflict');
    expect(cardChipLabel(CARDS[2])).toBe('No conflicts');
    expect(cardChipLabel(CARDS[10])).toBe('Needs your approval');
    const cards = withRunCards([CARDS[11]], ['r1', 'r2']);
    expect(cards.map((c) => (c.kind === 'run_status' ? c.run_id : c.kind))).toEqual(['r1', 'r2']);
    expect(withRunCards([], [])).toEqual([]);
  });
});
