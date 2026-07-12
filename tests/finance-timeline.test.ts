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
