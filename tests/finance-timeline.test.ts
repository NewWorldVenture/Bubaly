import { describe, it, expect } from 'vitest';
import {
  buildCashflowTimeline,
  monthlyEquivalent,
  isoWeekStart,
  type TimelineBill,
  type TimelineGoal,
} from '@/lib/finance/timeline';

const NOW = new Date('2026-01-05T00:00:00Z'); // a Monday

function bill(p: Partial<TimelineBill>): TimelineBill {
  return { name: 'Bill', amount: 100, due_date: '2026-01-10', is_recurring: false, recurrence: null, status: 'unpaid', category: null, ...p };
}

describe('monthlyEquivalent', () => {
  it('normalizes cadences to a monthly figure', () => {
    expect(monthlyEquivalent(bill({ is_recurring: true, recurrence: 'monthly', amount: 50 }))).toBe(50);
    expect(monthlyEquivalent(bill({ is_recurring: true, recurrence: 'yearly', amount: 120 }))).toBe(10);
    expect(monthlyEquivalent(bill({ is_recurring: true, recurrence: 'quarterly', amount: 30 }))).toBe(10);
    expect(monthlyEquivalent(bill({ is_recurring: false, recurrence: null }))).toBe(0);
  });
});

describe('isoWeekStart', () => {
  it('returns the Monday of the week', () => {
    expect(isoWeekStart(new Date('2026-01-07T12:00:00Z'))).toBe('2026-01-05'); // Wed → Mon
    expect(isoWeekStart(new Date('2026-01-11T23:00:00Z'))).toBe('2026-01-05'); // Sun → Mon
  });
});

describe('buildCashflowTimeline', () => {
  it('expands a monthly recurring bill across the horizon', () => {
    const t = buildCashflowTimeline({
      bills: [bill({ name: 'Rent', amount: 1000, due_date: '2026-01-10', is_recurring: true, recurrence: 'monthly' })],
      goals: [], events: [], startingBalance: 5000, horizonWeeks: 12, now: NOW,
    });
    // Jan 10, Feb 10, Mar 10 all fall inside a 12-week horizon → 3 occurrences.
    const rentMoments = t.weeks.flatMap((w) => w.moments).filter((m) => m.label === 'Rent');
    expect(rentMoments.length).toBe(3);
    expect(t.totalOutflow).toBe(3000);
    expect(t.monthlyRecurring).toBe(1000);
  });

  it('skips paid bills', () => {
    const t = buildCashflowTimeline({
      bills: [bill({ name: 'Water', amount: 80, status: 'paid' })],
      goals: [], events: [], startingBalance: 1000, now: NOW,
    });
    expect(t.totalOutflow).toBe(0);
  });

  it('projects a running balance and flags a negative shortfall as urgent', () => {
    const t = buildCashflowTimeline({
      bills: [bill({ name: 'Tuition', amount: 1200, due_date: '2026-01-12' })],
      goals: [], events: [], startingBalance: 500, buffer: 200, now: NOW,
    });
    expect(t.lowestBalance).toBe(500 - 1200);
    const low = t.insights.find((i) => i.kind === 'low_balance');
    expect(low?.severity).toBe('urgent');
  });

  it('overlays calendar events onto the heavy week and names them', () => {
    const t = buildCashflowTimeline({
      bills: [
        bill({ name: 'Car registration', amount: 1500, due_date: '2026-01-14' }), // the spike
        // a small baseline so the spike stands out (≥2 non-zero weeks)
        bill({ name: 'Groceries A', amount: 100, due_date: '2026-01-21' }),
        bill({ name: 'Groceries B', amount: 100, due_date: '2026-01-28' }),
      ],
      goals: [], events: [{ title: 'School ski trip', starts_at: '2026-01-15T09:00:00Z' }],
      startingBalance: 6000, now: NOW,
    });
    const heavy = t.insights.find((i) => i.kind === 'heavy_week');
    expect(heavy).toBeTruthy();
    expect(heavy!.detail).toContain('School ski trip');
  });

  it('turns a dated savings goal into a per-week set-aside insight', () => {
    const goal: TimelineGoal = { name: 'Summer camp', target_amount: 1000, current_amount: 200, target_date: '2026-02-16' };
    const t = buildCashflowTimeline({
      bills: [], goals: [goal], events: [], startingBalance: 5000, now: NOW,
    });
    const risk = t.insights.find((i) => i.kind === 'goal_at_risk');
    expect(risk).toBeTruthy();
    expect(risk!.amount).toBe(800); // remaining
    // 800 over ~6 weeks → a moment lands at the target date.
    const goalMoment = t.weeks.flatMap((w) => w.moments).find((m) => m.kind === 'goal');
    expect(goalMoment?.amount).toBe(800);
  });

  it('reports all-clear when nothing is heavy', () => {
    const t = buildCashflowTimeline({
      bills: [bill({ name: 'Netflix', amount: 15, due_date: '2026-01-20', is_recurring: true, recurrence: 'monthly' })],
      goals: [], events: [], startingBalance: 10000, now: NOW,
    });
    // A tiny recurring bill won't trip low-balance or heavy-week; recurring_creep is info.
    expect(t.insights.some((i) => i.kind === 'low_balance')).toBe(false);
    expect(t.insights[t.insights.length - 1].kind === 'all_clear' || t.insights.some((i) => i.kind === 'recurring_creep')).toBe(true);
  });
});

// ── Plan-linked commitments (M11 Family CFO) ─────────────────────────────────
// A trip, a move, a home project or a tracked subscription is money the family
// has already committed elsewhere in Bubaly; the forecast must carry it.
describe('plan-linked commitments', () => {
  it('lands a trip, a move and a project in the right week and lowers the projected low', () => {
    const t = buildCashflowTimeline({
      bills: [], goals: [], events: [], startingBalance: 5000, now: NOW,
      plans: [
        { label: 'Spring break', amount: 1200, date: '2026-02-14', source: 'vacation', category: 'travel' }, // Sat → week of Feb 9
        { label: 'Move to Elm St', amount: 800, date: '2026-03-02', source: 'move' },                        // Mon → week of Mar 2
        { label: 'Kitchen tap', amount: 300, date: '2026-01-20', source: 'project' },                       // Tue → week of Jan 19
      ],
    });
    const week = (ws: string) => t.weeks.find((w) => w.weekStart === ws)!;
    expect(week('2026-02-09').moments).toEqual([
      { date: '2026-02-14', label: 'Spring break', amount: 1200, kind: 'plan', category: 'travel', source: 'vacation' },
    ]);
    expect(week('2026-03-02').moments[0]).toMatchObject({ label: 'Move to Elm St', kind: 'plan', source: 'move', amount: 800 });
    expect(week('2026-01-19').moments[0]).toMatchObject({ label: 'Kitchen tap', kind: 'plan', source: 'project', amount: 300 });
    expect(t.planOutflow).toBe(2300);
    expect(t.totalOutflow).toBe(2300);
    expect(t.lowestBalance).toBe(5000 - 2300);
    expect(t.lowestBalanceWeek).toBe('2026-03-02');
  });

  it('defaults a plan moment’s category to its source when none is given', () => {
    const t = buildCashflowTimeline({
      bills: [], goals: [], events: [], startingBalance: 5000, now: NOW,
      plans: [{ label: 'Roof', amount: 100, date: '2026-01-20', source: 'project' }],
    });
    expect(t.weeks.flatMap((w) => w.moments)[0].category).toBe('project');
  });

  it('expands a subscription on its cadence and counts it in the monthly recurring figure', () => {
    const t = buildCashflowTimeline({
      bills: [], goals: [], events: [], startingBalance: 1000, now: NOW,
      plans: [{ label: 'Streaming', amount: 15, date: '2026-01-15', source: 'subscription', recurrence: 'monthly', category: 'entertainment' }],
    });
    const dates = t.weeks.flatMap((w) => w.moments).filter((m) => m.source === 'subscription').map((m) => m.date);
    expect(dates).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    expect(t.monthlyRecurring).toBe(15);
    expect(t.planOutflow).toBe(45);
  });

  it('lets a recurring bill win over a tracked subscription with the same name (no double count)', () => {
    const t = buildCashflowTimeline({
      bills: [bill({ name: 'Netflix', amount: 15, due_date: '2026-01-20', is_recurring: true, recurrence: 'monthly' })],
      goals: [], events: [], startingBalance: 1000, now: NOW,
      plans: [{ label: ' netflix ', amount: 15, date: '2026-01-20', source: 'subscription', recurrence: 'monthly' }],
    });
    const moments = t.weeks.flatMap((w) => w.moments);
    expect(moments.length).toBe(3);
    expect(moments.every((m) => m.kind === 'recurring')).toBe(true);
    expect(t.planOutflow).toBe(0);
    expect(t.monthlyRecurring).toBe(15);
  });

  it('drops a plan outside the horizon and lands an overdue one-off today rather than losing it', () => {
    const t = buildCashflowTimeline({
      bills: [], goals: [], events: [], startingBalance: 1000, now: NOW,
      plans: [
        { label: 'Far away', amount: 500, date: '2026-06-01', source: 'vacation' },
        { label: 'Overdue deposit', amount: 200, date: '2025-12-20', source: 'move' },
        { label: 'Nothing left', amount: 0, date: '2026-01-20', source: 'project' },
      ],
    });
    const moments = t.weeks.flatMap((w) => w.moments);
    expect(moments.map((m) => m.label)).toEqual(['Overdue deposit']);
    expect(moments[0].date).toBe('2026-01-05');
    expect(t.weeks[0].outflow).toBe(200);
  });

  it('leaves older callers untouched: no plans input means no plan moments', () => {
    const t = buildCashflowTimeline({ bills: [], goals: [], events: [], startingBalance: 100, now: NOW });
    expect(t.planOutflow).toBe(0);
    expect(t.scenarioOutflow).toBe(0);
    expect(t.coverage).toEqual({ coveredCount: 0, coveredAmount: 0, paidCount: 0, paidAmount: 0, openCount: 0, openAmount: 0 });
  });
});

// ── Coverage: which bills leave on their own ─────────────────────────────────
describe('coverage', () => {
  it('marks autopay occurrences covered, counts paid bills inside the horizon, and the rest as open', () => {
    const t = buildCashflowTimeline({
      bills: [
        bill({ name: 'Rent', amount: 1000, due_date: '2026-01-10', is_recurring: true, recurrence: 'monthly', autopay: true }), // ×3
        bill({ name: 'Water', amount: 80, due_date: '2026-01-12', status: 'paid' }),
        bill({ name: 'Tuition', amount: 500, due_date: '2026-01-20' }),
        bill({ name: 'Old paid bill', amount: 999, due_date: '2025-11-01', status: 'paid' }), // outside the horizon
      ],
      goals: [], events: [], startingBalance: 10000, now: NOW,
    });
    expect(t.coverage).toEqual({ coveredCount: 3, coveredAmount: 3000, paidCount: 1, paidAmount: 80, openCount: 1, openAmount: 500 });
    // Paid money already left the account: it never hits the projection.
    expect(t.totalOutflow).toBe(3500);
    const moments = t.weeks.flatMap((w) => w.moments);
    expect(moments.filter((m) => m.label === 'Rent').every((m) => m.covered === true)).toBe(true);
    expect(moments.find((m) => m.label === 'Tuition')?.covered).toBeUndefined();
  });
});

// ── What-if scenario ─────────────────────────────────────────────────────────
describe('scenario', () => {
  it('adds a one-off scenario as its own moment kind and reports its outflow separately', () => {
    const t = buildCashflowTimeline({
      bills: [], goals: [], events: [], startingBalance: 1000, now: NOW,
      scenario: { label: 'New laptop', amount: 900, date: '2026-01-21' },
    });
    const m = t.weeks.flatMap((w) => w.moments);
    expect(m).toEqual([{ label: 'New laptop', amount: 900, kind: 'scenario', date: '2026-01-21', category: 'scenario' }]);
    expect(t.scenarioOutflow).toBe(900);
    expect(t.planOutflow).toBe(0);
    expect(t.lowestBalance).toBe(100);
    expect(t.insights.find((i) => i.kind === 'low_balance')?.severity).toBe('watch');
  });

  it('ignores a null scenario and a non-positive amount', () => {
    const none = buildCashflowTimeline({ bills: [], goals: [], events: [], startingBalance: 1000, now: NOW, scenario: null });
    const zero = buildCashflowTimeline({ bills: [], goals: [], events: [], startingBalance: 1000, now: NOW, scenario: { label: 'x', amount: 0, date: '2026-01-21' } });
    expect(none.scenarioOutflow).toBe(0);
    expect(zero.scenarioOutflow).toBe(0);
  });
});
