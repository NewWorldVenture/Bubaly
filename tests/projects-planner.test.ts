import { describe, expect, it } from 'vitest';
import {
  SCOPE_TEMPLATES, suggestScope, materialsTotals, materialLineCents, compareQuotes, budgetHealth, schedule, nextAction, projectsSummary, columnFor,
  type ProjectLike, type MaterialLike, type QuoteLike,
} from '@/lib/projects/planner';

const TODAY = new Date('2026-09-05T12:00:00');
const project = (p: Partial<ProjectLike> & { id: string }): ProjectLike => ({ title: 'Project', status: 'planning', priority: 'medium', kind: 'repair', is_diy: true, budget_cents: 50000, labor_cents: 0, target_start: null, target_end: null, completed_at: null, ...p });
const material = (p: Partial<MaterialLike> & { id: string }): MaterialLike => ({ project_id: 'p1', name: 'Thing', quantity: 1, est_cost_cents: 1000, actual_cost_cents: null, is_purchased: false, ...p });
const quote = (p: Partial<QuoteLike> & { id: string }): QuoteLike => ({ project_id: 'p1', contractor_name: 'Pro', amount_cents: 100000, includes_materials: false, lead_time_days: 7, valid_until: null, status: 'received', ...p });

describe('scope templates', () => {
  it('have unique keys and match by keyword, best first', () => {
    expect(new Set(SCOPE_TEMPLATES.map((t) => t.key)).size).toBe(SCOPE_TEMPLATES.length);
    // Two keyword hits (faucet + dripping) outrank one (paint).
    expect(suggestScope('Paint the kids’ room and fix the dripping faucet').map((t) => t.key)).toEqual(['faucet', 'paint-room']);
    expect(suggestScope('Replace the bathroom vanity and shower tile')[0].key).toBe('bathroom');
    expect(suggestScope('nothing here')).toEqual([]);
  });
});

describe('materials', () => {
  it('totals estimates, actuals and what is left to buy', () => {
    const mats = [
      material({ id: 'a', quantity: 2, est_cost_cents: 4500, actual_cost_cents: 4200, is_purchased: true }),
      material({ id: 'b', est_cost_cents: 1500 }),
      material({ id: 'c', est_cost_cents: 800, is_purchased: true }), // purchased, no actual → falls back to estimate
      material({ id: 'other', project_id: 'p2', est_cost_cents: 99999 }),
    ];
    expect(materialLineCents(mats[0])).toBe(8400);
    expect(materialsTotals(mats, 'p1')).toEqual({ count: 3, purchased: 2, estimatedCents: 11300, actualCents: 9200, remainingCents: 1500 });
  });
});

describe('compareQuotes', () => {
  it('ranks accepted, then live cheapest, flags expired and computes spread', () => {
    const quotes = [
      quote({ id: 'q1', amount_cents: 120000 }),
      quote({ id: 'q2', amount_cents: 90000, contractor_name: 'Cheap' }),
      quote({ id: 'q3', amount_cents: 80000, valid_until: '2026-08-01' }), // expired
      quote({ id: 'q4', amount_cents: 0, status: 'requested' }),
      quote({ id: 'q5', project_id: 'p2', amount_cents: 1 }),
    ];
    const c = compareQuotes(quotes, 'p1', TODAY);
    expect(c.rows.map((r) => r.id)).toEqual(['q2', 'q1', 'q4', 'q3']);
    expect(c.rows[0].isLowest).toBe(true);
    expect(c.rows[1].vsLowestPct).toBe(33);
    expect(c.rows[3].isExpired).toBe(true);
    expect(c.received).toBe(2);
    expect(c.awaiting).toBe(1);
    expect(c.spreadPct).toBe(33);
    expect(c.accepted).toBeNull();
  });
});

describe('budgetHealth', () => {
  it('commits purchased materials, the accepted quote and labour; forecasts the rest', () => {
    const p = project({ id: 'p1', is_diy: false, budget_cents: 200000, labor_cents: 10000 });
    const mats = [material({ id: 'a', est_cost_cents: 20000, actual_cost_cents: 18000, is_purchased: true }), material({ id: 'b', est_cost_cents: 5000 })];
    const quotes = [quote({ id: 'q1', amount_cents: 150000, status: 'accepted' }), quote({ id: 'q2', amount_cents: 120000 })];
    const bh = budgetHealth(p, mats, quotes, TODAY);
    expect(bh.committedCents).toBe(178000);
    expect(bh.forecastCents).toBe(183000);
    expect(bh.status).toBe('near');
    expect(bh.pct).toBe(92);
    // Nothing accepted on a hired job → lowest live quote is the forecast.
    const bh2 = budgetHealth(p, mats, [quote({ id: 'q2', amount_cents: 120000 })], TODAY);
    expect(bh2.forecastCents).toBe(153000);
    expect(budgetHealth(project({ id: 'p1', budget_cents: null }), [], [], TODAY).status).toBe('no_budget');
    expect(budgetHealth(project({ id: 'p1', budget_cents: 1000 }), mats, [], TODAY).status).toBe('over');
  });
});

describe('schedule + nextAction', () => {
  it('classifies dates and names the next step from the data', () => {
    expect(schedule(project({ id: 'p1', target_end: '2026-09-01' }), TODAY)).toEqual({ state: 'overdue', days: -4 });
    expect(schedule(project({ id: 'p1', target_start: '2026-09-10' }), TODAY).state).toBe('due_soon');
    expect(schedule(project({ id: 'p1', status: 'done', target_end: '2026-01-01' }), TODAY).state).toBe('done');
    expect(nextAction(project({ id: 'p1', status: 'idea' }), [], [], TODAY)).toBe('Decide: DIY or hire, then set a budget');
    expect(nextAction(project({ id: 'p1', budget_cents: null }), [], [], TODAY)).toBe('Set a budget');
    expect(nextAction(project({ id: 'p1' }), [], [], TODAY)).toBe('List the materials');
    expect(nextAction(project({ id: 'p1' }), [material({ id: 'a' }), material({ id: 'b', is_purchased: true })], [], TODAY)).toBe('Buy the 1 remaining material');
    expect(nextAction(project({ id: 'p1', is_diy: false }), [], [], TODAY)).toBe('Request three quotes');
    expect(nextAction(project({ id: 'p1', is_diy: false }), [], [quote({ id: 'q' }), quote({ id: 'q2', amount_cents: 1 })], TODAY)).toBe('Compare 2 quotes and accept one');
    expect(nextAction(project({ id: 'p1', is_diy: false }), [], [quote({ id: 'q', status: 'accepted', contractor_name: 'Ana' })], TODAY)).toBe('Schedule with Ana');
  });
});

describe('projectsSummary + board', () => {
  it('counts active projects, overdue, over budget and waiting quotes', () => {
    const projects = [
      project({ id: 'p1', status: 'in_progress', target_end: '2026-09-01', budget_cents: 100000 }),
      project({ id: 'p2', status: 'quoting', is_diy: false, budget_cents: 50000 }),
      project({ id: 'p3', status: 'idea' }),
      project({ id: 'p4', status: 'done' }),
    ];
    const quotes = [quote({ id: 'q1', project_id: 'p2', status: 'requested', amount_cents: 0 })];
    const s = projectsSummary(projects, [], quotes, TODAY);
    expect(s.active).toBe(2);
    expect(s.ideas).toBe(1);
    expect(s.overdue).toBe(1);
    expect(s.quotesWaiting).toBe(1);
    expect(s.text).toBe('1 project past due');
    expect(columnFor('quoting')).toBe('planning');
    expect(columnFor('cancelled')).toBe('done');
  });
});
