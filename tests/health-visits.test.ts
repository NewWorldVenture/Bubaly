import { describe, it, expect } from 'vitest';
import { daysUntilFollowUp, upcomingFollowUps, sortByVisitDate, visitKindMeta } from '@/lib/health/visits';

const today = new Date('2026-06-23T12:00:00');

describe('daysUntilFollowUp', () => {
  it('computes days (negative = overdue), null when unset', () => {
    expect(daysUntilFollowUp({ follow_up_date: '2026-06-25', visit_date: '2026-06-01' }, today)).toBe(2);
    expect(daysUntilFollowUp({ follow_up_date: '2026-06-20', visit_date: '2026-06-01' }, today)).toBe(-3);
    expect(daysUntilFollowUp({ follow_up_date: null, visit_date: '2026-06-01' }, today)).toBeNull();
    expect(daysUntilFollowUp({ follow_up_date: 'bad', visit_date: '2026-06-01' }, today)).toBeNull();
  });
});

describe('upcomingFollowUps', () => {
  it('keeps within-window follow-ups, most overdue first, drops far/none', () => {
    const visits = [
      { id: 'a', follow_up_date: '2026-06-25', visit_date: '2026-06-01' },
      { id: 'b', follow_up_date: '2026-06-18', visit_date: '2026-05-01' }, // overdue
      { id: 'c', follow_up_date: null, visit_date: '2026-06-10' },
      { id: 'd', follow_up_date: '2027-01-01', visit_date: '2026-06-10' }, // far out
    ];
    const out = upcomingFollowUps(visits, 60, today);
    expect(out.map((v) => v.id)).toEqual(['b', 'a']);
  });
});

describe('sortByVisitDate', () => {
  it('newest first', () => {
    const out = sortByVisitDate([{ visit_date: '2026-01-01' }, { visit_date: '2026-06-01' }, { visit_date: '2026-03-01' }]);
    expect(out.map((v) => v.visit_date)).toEqual(['2026-06-01', '2026-03-01', '2026-01-01']);
  });
});

describe('visitKindMeta', () => {
  it('maps known + unknown kinds', () => {
    expect(visitKindMeta('dental').label).toBe('Dental');
    expect(visitKindMeta('zzz')).toEqual({ label: 'zzz', icon: '📋' });
  });
});
