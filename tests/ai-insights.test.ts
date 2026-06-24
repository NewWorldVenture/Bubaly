import { describe, it, expect } from 'vitest';
import { INSIGHTS, INSIGHT_META, isInsightKind, type InsightData, type InsightKind } from '@/lib/ai/insights';

const ALL_KINDS: InsightKind[] = [
  'chores', 'calendar', 'expenses', 'grocery', 'homework', 'medications', 'shopping',
  'subscriptions', 'todos', 'trips', 'wishlists', 'home', 'notifications', 'messages',
  'weather', 'settings', 'event',
];

function baseData(overrides: Partial<InsightData> = {}): InsightData {
  return {
    familyName: 'The Tests',
    now: 'Wednesday, June 24, 2026, 3:00 PM',
    members: [{ id: 'm1', name: 'Alex' }, { id: 'm2', name: 'Sam' }],
    rows: {},
    params: {},
    ...overrides,
  };
}

describe('insights registry', () => {
  it('defines every kind with a non-empty system prompt, label, and buildUser', () => {
    for (const k of ALL_KINDS) {
      const def = INSIGHTS[k];
      expect(def, k).toBeTruthy();
      expect(def.system.length, k).toBeGreaterThan(20);
      expect(def.label.length, k).toBeGreaterThan(0);
      expect(def.maxTokens, k).toBeGreaterThan(0);
      expect(typeof def.buildUser, k).toBe('function');
    }
  });

  it('every buildUser returns a string even with empty data (no throws)', () => {
    for (const k of ALL_KINDS) {
      const out = INSIGHTS[k].buildUser(baseData());
      expect(typeof out, k).toBe('string');
      expect(out.includes('The Tests'), k).toBe(true);
    }
  });

  it('INSIGHT_META mirrors the registry and hides prompt internals', () => {
    for (const k of ALL_KINDS) {
      expect(INSIGHT_META[k].title).toBe(INSIGHTS[k].title);
      expect(INSIGHT_META[k].label).toBe(INSIGHTS[k].label);
      expect((INSIGHT_META[k] as Record<string, unknown>).system).toBeUndefined();
    }
  });

  it('isInsightKind guards correctly', () => {
    expect(isInsightKind('chores')).toBe(true);
    expect(isInsightKind('event')).toBe(true);
    expect(isInsightKind('nope')).toBe(false);
    expect(isInsightKind(42)).toBe(false);
  });
});

describe('grounding: prompts carry the real data', () => {
  it('chores reflects assignments and resolves member names', () => {
    const out = INSIGHTS.chores.buildUser(baseData({
      rows: {
        chores: [{ title: 'Dishes', points: 10, priority: 'high', category: 'kitchen' }],
        chore_assignments: [{ member_id: 'm1', status: 'todo', due_at: '2026-06-25T00:00:00Z' }],
      },
    }));
    expect(out).toContain('Dishes');
    expect(out).toContain('Alex'); // member id resolved to name
    expect(out).toContain('2026-06-25');
  });

  it('expenses totals and groups by category in dollars', () => {
    const out = INSIGHTS.expenses.buildUser(baseData({
      rows: {
        expense_splits: [
          { description: 'Groceries', total_cents: 5000, category: 'Food', spent_on: '2026-06-20' },
          { description: 'Gas', total_cents: 4000, category: 'Transport', spent_on: '2026-06-21' },
          { description: 'Snacks', total_cents: 1000, category: 'Food', spent_on: '2026-06-22' },
        ],
      },
    }));
    expect(out).toContain('$100.00'); // total of all three
    expect(out).toContain('Food: $60.00'); // category aggregation
    expect(out).toContain('Transport: $40.00');
  });

  it('subscriptions estimates a monthly total across cadences', () => {
    const out = INSIGHTS.subscriptions.buildUser(baseData({
      rows: {
        subscriptions_tracked: [
          { name: 'Streaming', cost_cents: 1500, cadence: 'monthly', status: 'active' },
          { name: 'Cloud', cost_cents: 12000, cadence: 'yearly', status: 'active' },
        ],
      },
    }));
    expect(out).toContain('Streaming');
    expect(out).toContain('$15.00/monthly');
    expect(out).toMatch(/\$25\.00\/month/); // 15 + (120/12=10) = 25
  });

  it('event prep uses the single provided event, or asks for one when missing', () => {
    const withEvent = INSIGHTS.event.buildUser(baseData({
      rows: { calendar_events: [{ title: 'Soccer game', starts_at: '2026-06-26T17:30:00Z', category: 'sports', location: 'Field 3', assignee_id: 'm2' }] },
    }));
    expect(withEvent).toContain('Soccer game');
    expect(withEvent).toContain('Field 3');
    expect(withEvent).toContain('Sam');

    const noEvent = INSIGHTS.event.buildUser(baseData({ rows: { calendar_events: [] } }));
    expect(noEvent.toLowerCase()).toContain('need an event');
  });

  it('a focusing question is appended when provided', () => {
    const out = INSIGHTS.todos.buildUser(baseData({
      rows: { todo_items: [{ title: 'Call plumber', priority: 'high' }] },
      params: { question: 'what is most urgent before the weekend?' },
    }));
    expect(out).toContain('what is most urgent before the weekend?');
  });
});
