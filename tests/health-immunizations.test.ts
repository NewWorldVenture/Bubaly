import { describe, it, expect } from 'vitest';
import { daysUntilDue, dueStatus, dueImmunizations, sortByDateGiven } from '@/lib/health/immunizations';

const today = new Date('2026-06-23T12:00:00');

describe('daysUntilDue / dueStatus', () => {
  it('computes days and status bands', () => {
    expect(daysUntilDue({ next_due_date: '2026-06-25' }, today)).toBe(2);
    expect(dueStatus({ next_due_date: '2026-06-20' }, today)).toBe('overdue');
    expect(dueStatus({ next_due_date: '2026-07-10' }, today)).toBe('due_soon');
    expect(dueStatus({ next_due_date: '2026-12-01' }, today)).toBe('upcoming');
    expect(dueStatus({ next_due_date: null }, today)).toBe('none');
    expect(daysUntilDue({ next_due_date: 'bad' }, today)).toBeNull();
  });
});

describe('dueImmunizations', () => {
  it('keeps within-window (incl. overdue) most-overdue-first, drops far/none', () => {
    const items = [
      { id: 'a', next_due_date: '2026-07-01' },
      { id: 'b', next_due_date: '2026-06-10' }, // overdue
      { id: 'c', next_due_date: null },
      { id: 'd', next_due_date: '2027-01-01' }, // far
    ];
    expect(dueImmunizations(items, 60, today).map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('sortByDateGiven', () => {
  it('newest first; nulls last', () => {
    const out = sortByDateGiven([{ date_given: '2025-01-01' }, { date_given: null }, { date_given: '2026-01-01' }]);
    expect(out.map((x) => x.date_given)).toEqual(['2026-01-01', '2025-01-01', null]);
  });
});
