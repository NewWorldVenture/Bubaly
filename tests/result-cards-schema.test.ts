// Result cards (§53): the schema every surface trusts, the tool-result → card
// translation the engine and the evals share, the SSE/JSON/`structured_content`
// contracts, and the phone's structural parse of the same cards.
import { describe, expect, it } from 'vitest';
import {
  RESULT_CARD_KINDS, ResultCardSchema, approvalIdFromToolResult, canonicalToolName, cardFromToolResult, formatMoney,
  parseAssistantStreamEvent, parseResultCard, runHref, runIdFromToolResult, runStatusCard, structuredContentFrom,
  summaryCardFromData, toStructuredContent, type ResultCard,
} from '@/lib/ai/result-cards';
import { cardSections, parseAssistantResponse, parseCards } from '@/mobile/src/lib/assistant-core';

const MEAL_PLAN: ResultCard = {
  kind: 'meal_plan', title: '5 dinners planned', week_start: '2026-09-07',
  days: [{ date: '2026-09-07', label: 'Mon, Sep 7', meals: [{ meal_type: 'dinner', name: 'Tacos' }] }],
};

const SAMPLE_CARDS: ResultCard[] = [
  MEAL_PLAN,
  { kind: 'calendar_conflict', title: '1 overlap', conflicts: [{ when: 'Saturday at 10:00 AM', titles: ['Soccer', 'Dentist'], member: 'Sam', event_ids: ['e1', 'e2'] }] },
  { kind: 'budget_analysis', title: 'September', currency: 'USD', total_spent: 420, total_limit: 500, rows: [{ label: 'Groceries', spent: 420, limit: 500, share: null, delta: null, over: false }], insight: 'On track.' },
  { kind: 'vacation_prep', title: 'Trip drafted', trip_id: 't1', destination: 'Lisbon', dates: '2026-10-01 – 2026-10-08', items: [{ label: '3 activities', detail: null, done: true }], next_steps: [] },
  { kind: 'task_group', title: '2 tasks', tasks: [{ id: 'a', title: 'Order forms', assignee: 'Dan', due: 'Friday', done: false }, { id: 'b', title: 'Dishes', assignee: null, due: null, done: true }] },
  { kind: 'grocery_list', title: '4 items added', list_id: 'l1', items: [{ name: 'Milk', quantity: '2', category: 'Dairy', checked: false }], skipped: ['Eggs'], in_pantry: [] },
  { kind: 'readiness', title: 'Lisbon is 72/100 ready', score: 72, level: 'mostly ready', days_until: 12, factors: [{ label: 'Documents', score: 40 }], recommendations: ['Renew Sam’s passport'], risks: [{ title: 'Passport expires', detail: 'Sam, 3 months', severity: 3 }] },
  { kind: 'summary', title: 'Saved', facts: [{ label: 'Points', value: '5' }], items: ['Dishes'], note: null },
  {
    kind: 'approval', title: 'Add soccer Saturday',
    approval: { id: 'ap1', title: 'Add soccer Saturday', summary: null, consequences: ['Adds an event'], domain: 'calendar', requestedBy: 'Bubaly', requestedAt: '2026-09-05T10:00:00Z', expiresAt: null, runId: null, amountCents: null, canEdit: false },
  },
  { kind: 'run_status', title: 'Bubaly is working on it', run_id: 'r1', status: 'executing', summary: 'Planning the week', steps_done: 1, steps_total: 4, href: '/dashboard/concierge/runs/r1' },
];

describe('ResultCardSchema', () => {
  it('covers exactly the ten kinds, and every sample of each kind parses', () => {
    expect([...RESULT_CARD_KINDS].sort()).toEqual([
      'approval', 'budget_analysis', 'calendar_conflict', 'grocery_list', 'meal_plan', 'readiness', 'run_status', 'summary', 'task_group', 'vacation_prep',
    ]);
    expect(SAMPLE_CARDS.map((c) => c.kind).sort()).toEqual([...RESULT_CARD_KINDS].sort());
    for (const card of SAMPLE_CARDS) {
      const parsed = ResultCardSchema.safeParse(card);
      expect(parsed.success, card.kind).toBe(true);
    }
  });

  it('rejects unknown kinds, missing titles and out-of-range scores instead of trusting them', () => {
    expect(parseResultCard({ kind: 'chain_of_thought', title: 'x' })).toBeNull();
    expect(parseResultCard({ kind: 'summary', facts: [], items: [] })).toBeNull();
    expect(parseResultCard({ ...SAMPLE_CARDS[6], score: 140 })).toBeNull();
    expect(parseResultCard(null)).toBeNull();
    expect(parseResultCard('meal_plan')).toBeNull();
  });

  it('never carries a tool name or arguments — only what a person reads', () => {
    for (const card of SAMPLE_CARDS) {
      const keys = Object.keys(card);
      expect(keys).not.toContain('tool_name');
      expect(keys).not.toContain('args');
      expect(keys).not.toContain('reasoning');
    }
  });
});

describe('cardFromToolResult', () => {
  it('resolves every spelling of a tool name to the canonical one', () => {
    expect(canonicalToolName('meals.planWeek')).toBe('meals.planWeek');
    expect(canonicalToolName('meals_planWeek')).toBe('meals.planWeek');
    expect(canonicalToolName('plan_week_meals')).toBe('meals.planWeek');
    expect(canonicalToolName('find_calendar_conflicts')).toBe('calendar.findConflicts');
    expect(canonicalToolName('add_chore')).toBe('add_chore');
  });

  it('turns meals.planWeek output into a meal plan card ordered by day', () => {
    const card = cardFromToolResult('meals_planWeek', { entries: [] }, {
      ok: true, summary: 'Planned 2 dinners',
      data: {
        planned: [
          { id: 's2', date: '2026-09-08', meal_type: 'dinner', meal_id: null, name: 'Pasta' },
          { id: 's1', date: '2026-09-07', meal_type: 'dinner', meal_id: 'm1', name: 'Tacos' },
          { id: 's3', date: '2026-09-07', meal_type: 'breakfast', meal_id: null, name: 'Oats' },
        ],
        replaced: 1, created_meals: 2,
      },
    });
    expect(card?.kind).toBe('meal_plan');
    if (card?.kind !== 'meal_plan') return;
    expect(card.title).toBe('Planned 2 dinners');
    expect(card.days.map((d) => d.date)).toEqual(['2026-09-07', '2026-09-08']);
    expect(card.days[0].meals.map((m) => m.meal_type)).toEqual(['breakfast', 'dinner']);
    expect(card.days[0].label).toBe('Mon, Sep 7');
    expect(card.replaced).toBe(1);
    expect(card.href).toBe('/dashboard/meals');
  });

  it('names people on a conflict card instead of leaking member ids', () => {
    const card = cardFromToolResult('calendar.findConflicts', {}, {
      ok: true, summary: '1 conflict',
      data: { conflicts: [{ member_id: 'm1', event_ids: ['e1', 'e2'], titles: ['Soccer', 'Dentist'], when: 'Saturday at 10:00 AM' }] },
    }, { members: { m1: 'Sam' } });
    expect(card).toMatchObject({ kind: 'calendar_conflict', conflicts: [{ member: 'Sam', titles: ['Soccer', 'Dentist'] }] });
  });

  it('builds a budget card from budgetVsActual with limits, and from comparePeriods with deltas', () => {
    const vsActual = cardFromToolResult('finances.budgetVsActual', {}, {
      ok: true, summary: '1 budget over',
      data: {
        month: '2026-09', total_limit: 900, total_spent: 950, over_count: 1,
        budgets: [
          { budget_id: 'b1', category: 'Groceries', period: 'monthly', limit: 500, spent: 620, remaining: -120, pct: 124, over: true, window: { from: '2026-09-01', to: '2026-09-30' }, transaction_count: 12 },
          { budget_id: 'b2', category: 'Fuel', period: 'monthly', limit: 400, spent: 330, remaining: 70, pct: 82, over: false, window: { from: '2026-09-01', to: '2026-09-30' }, transaction_count: 4 },
        ],
      },
    });
    expect(vsActual).toMatchObject({ kind: 'budget_analysis', period: '2026-09', total_limit: 900, total_spent: 950, insight: '1 budget is over.' });
    if (vsActual?.kind !== 'budget_analysis') return;
    expect(vsActual.rows[0]).toEqual({ label: 'Groceries', spent: 620, limit: 500, share: 124, delta: null, over: true });

    const compared = cardFromToolResult('compare_spending_periods', {}, {
      ok: true, summary: 'Spending up $50',
      data: {
        range: { from: '2026-08-01', to: '2026-08-31' }, previous_range: { from: '2026-07-01', to: '2026-07-31' },
        current: 1250, previous: 1200, delta: 50, delta_pct: 4.2,
        categories: [{ category: 'Dining', current: 300, previous: 200, delta: 100, delta_pct: 50 }],
      },
    });
    expect(compared).toMatchObject({ kind: 'budget_analysis', previous_total: 1200, insight: 'Spending is up $50 versus the previous period.' });
    if (compared?.kind !== 'budget_analysis') return;
    expect(compared.rows[0]).toMatchObject({ label: 'Dining', delta: 100, over: true });
  });

  it('builds readiness, grocery, task-group and trip cards from their tools', () => {
    const readiness = cardFromToolResult('trips.computeReadiness', { vacation_id: 't1' }, {
      ok: true, summary: 'Lisbon is 72/100 ready',
      data: { trip_id: 't1', title: 'Lisbon', score: 72, level: 'mostly_ready', days_until: 12, factors: [{ key: 'docs', label: 'Documents', score: 40 }], recommendations: ['Renew passport'], document_risks: [{ kind: 'passport', member_id: 'm1', title: 'Passport expires', detail: 'in 3 months', severity: 3 }], itinerary_conflicts: 0, budget: { planned_cents: 1000, spent_cents: 0, over: false } },
    });
    expect(readiness).toMatchObject({ kind: 'readiness', score: 72, level: 'mostly ready', href: '/dashboard/vacations/t1', risks: [{ title: 'Passport expires' }] });

    const groceries = cardFromToolResult('groceries.addFromMealPlan', {}, {
      ok: true, summary: 'Added 2 items',
      data: { list_id: 'l1', added: [{ id: 'g1', name: 'Milk', quantity: '2', category: 'Dairy' }, { id: 'g2', name: 'Tortillas', quantity: null, category: null }], skipped: ['Eggs'], in_pantry: ['Rice'], meals: [] },
    });
    expect(groceries).toMatchObject({ kind: 'grocery_list', list_id: 'l1', skipped: ['Eggs'], in_pantry: ['Rice'] });
    if (groceries?.kind !== 'grocery_list') return;
    expect(groceries.items.map((i) => i.name)).toEqual(['Milk', 'Tortillas']);

    const tasks = cardFromToolResult('tasks.searchTodos', {}, {
      ok: true, summary: '2 tasks',
      data: { todos: [{ id: 'a', title: 'Order forms', list_id: 'l', due_date: '2026-09-11', priority: 'normal', assigned_to_id: 'm1', is_done: false, due: 'Friday' }] },
    }, { members: { m1: 'Dan' } });
    expect(tasks).toMatchObject({ kind: 'task_group', tasks: [{ title: 'Order forms', assignee: 'Dan', due: 'Friday', done: false }], href: '/dashboard/todos' });

    const trip = cardFromToolResult('trips.buildPlan', { vacation_id: 't1' }, {
      ok: true, summary: 'Drafted the trip', data: { built: true, reason: null, added: { activities: 3, items: 5, budget: 2, packing: 0 } },
    });
    expect(trip).toMatchObject({ kind: 'vacation_prep', trip_id: 't1', href: '/dashboard/vacations/t1' });
    if (trip?.kind !== 'vacation_prep') return;
    expect(trip.items.map((i) => i.label)).toEqual(['3 activities', '5 itinerary entries', '2 budget lines']);
  });

  it('defaults to a summary card for structured output no other kind claims, and to nothing for id-only or failed results', () => {
    const summary = cardFromToolResult('tasks.createChore', { title: 'Dishes' }, {
      ok: true, summary: 'Created chore “Dishes”', data: { id: 'c1', title: 'Dishes', points: 5, due_at: null, assignment: null, due: 'Saturday' },
    });
    expect(summary).toMatchObject({ kind: 'summary', title: 'Created chore “Dishes”' });
    if (summary?.kind !== 'summary') return;
    expect(summary.facts).toEqual([{ label: 'Title', value: 'Dishes' }, { label: 'Points', value: '5' }, { label: 'Due', value: 'Saturday' }]);

    expect(cardFromToolResult('create_calendar_event', {}, { ok: true, id: 'e1', summary: 'Added soccer.' })).toBeNull();
    expect(cardFromToolResult('tasks.createChore', {}, { ok: true, summary: 'Done', data: { id: 'c1', list_id: 'l1' } })).toBeNull();
    expect(cardFromToolResult('meals.planWeek', {}, { ok: false, error: 'Not allowed' })).toBeNull();
    expect(cardFromToolResult('meals.planWeek', {}, 'raw')).toBeNull();
    expect(summaryCardFromData('T', { id: 'x' })).toBeNull();
  });

  it('lets an explicit, valid card on the result win over derivation, and ignores an invalid one', () => {
    expect(cardFromToolResult('tasks.createChore', {}, { ok: true, summary: 's', card: MEAL_PLAN, data: { title: 'x' } })).toEqual(MEAL_PLAN);
    const derived = cardFromToolResult('tasks.createChore', {}, { ok: true, summary: 's', card: { kind: 'nope' }, data: { title: 'x' } });
    expect(derived?.kind).toBe('summary');
  });

  it('finds run and approval ids wherever an adapter put them', () => {
    expect(runIdFromToolResult({ ok: true, summary: 's', run_id: 'r1' })).toBe('r1');
    expect(runIdFromToolResult({ ok: true, summary: 's', data: { runId: 'r2' } })).toBe('r2');
    expect(runIdFromToolResult({ ok: false, error: 'x', run_id: 'r1' })).toBeNull();
    expect(approvalIdFromToolResult({ ok: true, summary: 's', pending_approval: true, approval_id: 'ap1' })).toBe('ap1');
    expect(approvalIdFromToolResult({ ok: true, summary: 's', approval_id: 'ap1' })).toBeNull();
  });

  it('formats money without throwing on a bad currency', () => {
    expect(formatMoney(1234, 'USD')).toBe('$1,234');
    expect(formatMoney(12.5, 'USD')).toBe('$12.50');
    expect(formatMoney(3, 'NOPE')).toBe('$3.00');
  });
});

describe('stream and persistence contracts', () => {
  it('parses every event type and drops malformed ones', () => {
    expect(parseAssistantStreamEvent({ type: 'delta', text: 'Hi' })).toEqual({ type: 'delta', text: 'Hi' });
    expect(parseAssistantStreamEvent({ type: 'action', name: 'add_chore', ok: true, summary: 'Added.' })).toEqual({ type: 'action', name: 'add_chore', ok: true, summary: 'Added.' });
    expect(parseAssistantStreamEvent({ type: 'card', card: MEAL_PLAN })).toEqual({ type: 'card', card: MEAL_PLAN });
    expect(parseAssistantStreamEvent({ type: 'card', card: { kind: 'nope' } })).toBeNull();
    expect(parseAssistantStreamEvent({ type: 'run', runId: 'r1' })).toEqual({ type: 'run', runId: 'r1', href: '/dashboard/concierge/runs/r1', status: 'queued', summary: null });
    expect(parseAssistantStreamEvent({ type: 'run' })).toBeNull();
    expect(parseAssistantStreamEvent({ type: 'error' })).toEqual({ type: 'error', error: 'Something went wrong.' });
    expect(parseAssistantStreamEvent({ type: 'done', content: 'Done.', persisted: false })).toEqual({ type: 'done', content: 'Done.', persisted: false });
    expect(parseAssistantStreamEvent({ type: 'thinking', text: 'secret' })).toBeNull();
    expect(parseAssistantStreamEvent('data')).toBeNull();
  });

  it('round-trips structured_content and re-validates stored cards', () => {
    expect(toStructuredContent([], [])).toBeNull();
    const stored = toStructuredContent([MEAL_PLAN], ['r1', 'r1', 'r2']);
    expect(stored).toEqual({ version: 1, cards: [MEAL_PLAN], runIds: ['r1', 'r2'] });
    expect(structuredContentFrom(JSON.parse(JSON.stringify(stored)))).toEqual({ cards: [MEAL_PLAN], runIds: ['r1', 'r2'] });
    expect(structuredContentFrom({ version: 1, cards: [MEAL_PLAN, { kind: 'legacy' }], runIds: [3, 'r1'] })).toEqual({ cards: [MEAL_PLAN], runIds: ['r1'] });
    expect(structuredContentFrom(null)).toEqual({ cards: [], runIds: [] });
  });

  it('builds run cards with family-facing titles and the run page link', () => {
    expect(runHref('r 1')).toBe('/dashboard/concierge/runs/r%201');
    expect(runStatusCard({ runId: 'r1' })).toMatchObject({ kind: 'run_status', title: 'Bubaly is getting started', status: 'queued', href: '/dashboard/concierge/runs/r1' });
    expect(runStatusCard({ runId: 'r1', status: 'awaiting_approval', stepsDone: 2, stepsTotal: 5 })).toMatchObject({ title: 'Waiting for your approval', steps_done: 2, steps_total: 5 });
    expect(runStatusCard({ runId: 'r1', status: 'weird' }).title).toBe('Bubaly is on it');
  });
});

describe('mobile card parsing', () => {
  it('keeps well-formed cards from the JSON reply and drops the rest', () => {
    expect(parseCards([MEAL_PLAN, { kind: 'x' }, { title: 'no kind' }, null, 'str'])).toEqual([MEAL_PLAN]);
    expect(parseCards(undefined)).toEqual([]);
    const parsed = parseAssistantResponse(200, { conversationId: 'c', content: 'Done.', actions: [], cards: [MEAL_PLAN], runIds: ['r1', 7], persisted: true });
    expect(parsed).toMatchObject({ ok: true, reply: { cards: [MEAL_PLAN], runIds: ['r1'] } });
  });

  it('renders every kind as a titled section with readable lines', () => {
    for (const card of SAMPLE_CARDS) {
      const section = cardSections(card);
      expect(section.title.length, card.kind).toBeGreaterThan(0);
      expect(section.lines.every((l) => typeof l === 'string'), card.kind).toBe(true);
    }
    expect(cardSections(MEAL_PLAN)).toMatchObject({ lines: ['Mon, Sep 7: Tacos'], tone: 'brand' });
    expect(cardSections(SAMPLE_CARDS[1])).toMatchObject({ lines: ['Soccer and Dentist overlap Saturday at 10:00 AM · Sam'], tone: 'warning' });
    expect(cardSections(SAMPLE_CARDS[2]).lines).toEqual(['$420 of $500', 'Groceries: $420 / $500', 'On track.']);
    expect(cardSections(SAMPLE_CARDS[6])).toMatchObject({ title: 'Lisbon is 72/100 ready · 72/100', subtitle: 'mostly ready · 12 days to go', lines: ['⚠ Passport expires', '1. Renew Sam’s passport'], tone: 'warning' });
    expect(cardSections(SAMPLE_CARDS[9])).toMatchObject({ subtitle: 'executing', lines: ['Planning the week', '1 of 4 steps'], href: '/dashboard/concierge/runs/r1' });
    expect(cardSections(SAMPLE_CARDS[8])).toMatchObject({ tone: 'warning', lines: ['Adds an event'] });
  });

  it('caps long lists and still renders a kind it has never seen', () => {
    const long = cardSections({ kind: 'summary', title: 'T', facts: [], items: Array.from({ length: 10 }, (_, i) => `item ${i}`), note: null });
    expect(long.lines).toHaveLength(6);
    expect(long.more).toBe(4);
    expect(cardSections({ kind: 'future_kind', title: 'New', detail: 'Something', count: 3 })).toMatchObject({ tone: 'muted', lines: ['detail: Something'] });
  });
});
