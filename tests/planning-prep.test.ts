import { describe, it, expect } from 'vitest';
import { generatePrepPlans, actionablePlans, type HorizonSignal } from '@/lib/planning/prep';

const NOW = new Date('2026-07-06T12:00:00Z');

const signals: HorizonSignal[] = [
  { id: 'trip1', kind: 'trip', title: 'Beach Trip', date: '2026-07-27' },       // 21 days out
  { id: 'bday1', kind: 'birthday', title: "Emma's Birthday", date: '2026-09-01' }, // ~57 days
  { id: 'doc1', kind: 'doc_expiry', title: 'Passport', date: '2026-07-10' },     // 4 days out
  { id: 'past', kind: 'event', title: 'Old Thing', date: '2026-06-01' },         // past → dropped
];

describe('generatePrepPlans', () => {
  it('drops past-dated signals', () => {
    const plans = generatePrepPlans(signals, NOW);
    expect(plans.some((p) => p.signalId === 'past')).toBe(false);
  });

  it('builds a titled, ordered plan per upcoming signal', () => {
    const plans = generatePrepPlans(signals, NOW);
    expect(plans).toHaveLength(3);
    const trip = plans.find((p) => p.signalId === 'trip1')!;
    expect(trip.title).toBe('Get ready: Beach Trip');
    expect(trip.daysUntil).toBe(21);
    // steps ordered soonest-due first
    for (let i = 1; i < trip.steps.length; i++) {
      expect(trip.steps[i - 1].dueDate <= trip.steps[i].dueDate).toBe(true);
    }
  });

  it('computes each step due date as target minus lead days', () => {
    const trip = generatePrepPlans([signals[0]], NOW)[0];
    const pack = trip.steps.find((s) => s.label.includes('Pack the night before'))!;
    expect(pack.leadDays).toBe(1);
    expect(pack.dueDate).toBe('2026-07-26'); // 27th minus 1
  });

  it('marks steps whose lead window already opened as overdue', () => {
    // Beach trip in 21 days: the 30-day passport step opened 9 days ago → overdue.
    const trip = generatePrepPlans([signals[0]], NOW)[0];
    const passport = trip.steps.find((s) => s.leadDays === 30)!;
    expect(passport.overdue).toBe(true);
    expect(trip.urgency).toBe('now'); // has an overdue step
  });

  it('flags near-term signals as urgent even without an overdue step', () => {
    const doc = generatePrepPlans([signals[2]], NOW)[0]; // 4 days out
    expect(doc.urgency).toBe('now');
  });

  it('classifies a far-off birthday as soon/later, not now', () => {
    const bday = generatePrepPlans([signals[1]], NOW)[0]; // 57 days out
    expect(bday.urgency).not.toBe('now');
  });

  describe.each([
    { kind: 'trip', leadDays: 30 },
    { kind: 'birthday', leadDays: 21 },
    { kind: 'doc_expiry', leadDays: 30 },
    { kind: 'school_start', leadDays: 21 },
    { kind: 'event', leadDays: 7 },
  ] as const)('$kind preparation window', ({ kind, leadDays }) => {
    it.each([
      { offset: -1, urgency: 'now' },
      { offset: 0, urgency: 'now' },
      { offset: 1, urgency: 'soon' },
      { offset: 7, urgency: 'soon' },
      { offset: 8, urgency: 'later' },
    ] as const)('is $urgency when the first step opens in $offset days', ({ offset, urgency }) => {
      const date = new Date(Date.UTC(2026, 6, 6 + leadDays + offset)).toISOString().slice(0, 10);
      const plans = generatePrepPlans([{ id: kind, kind, title: 'Upcoming plan', date }], NOW);
      const plan = plans[0];

      expect(plan.urgency).toBe(urgency);
      expect(plan.steps[0].leadDays).toBe(leadDays);
      expect(plan.steps[0].dueDate).toBe(new Date(Date.UTC(2026, 6, 6 + offset)).toISOString().slice(0, 10));
      expect(plan.steps[0].overdue).toBe(offset < 0);
      expect(actionablePlans(plans)).toBe(urgency === 'now' ? 1 : 0);
    });
  });

  it('sorts plans by target date', () => {
    const plans = generatePrepPlans(signals, NOW);
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i - 1].targetDate <= plans[i].targetDate).toBe(true);
    }
  });

  it('handles an unknown/empty template kind without steps', () => {
    const plans = generatePrepPlans([{ id: 'e', kind: 'event', title: 'Recital', date: '2026-07-09' }], NOW);
    expect(plans[0].steps.length).toBeGreaterThan(0); // event has a template
  });

  it('actionablePlans counts only urgency=now', () => {
    const plans = generatePrepPlans(signals, NOW);
    expect(actionablePlans(plans)).toBe(2); // trip (overdue step) + passport (near)
  });

  it('returns nothing for no signals', () => {
    expect(generatePrepPlans([], NOW)).toEqual([]);
  });
});
