import { describe, it, expect } from 'vitest';
import {
  isOpen, daysToDeadline, isMissed, isClosingSoon, urgencyBucket,
  groupByUrgency, opportunityStats, type OpportunityLike,
} from '@/lib/opportunities/deadlines';

const today = '2026-06-21';
const op = (over: Partial<OpportunityLike>): OpportunityLike => ({
  id: Math.random().toString(36).slice(2), deadline: '2026-06-30', status: 'interested', ...over,
});

describe('isOpen', () => {
  it('is true for interested/waitlisted only', () => {
    expect(isOpen(op({ status: 'interested' }))).toBe(true);
    expect(isOpen(op({ status: 'waitlisted' }))).toBe(true);
    expect(isOpen(op({ status: 'registered' }))).toBe(false);
    expect(isOpen(op({ status: 'passed' }))).toBe(false);
  });
});

describe('daysToDeadline', () => {
  it('counts whole days, signed', () => {
    expect(daysToDeadline(op({ deadline: '2026-06-28' }), today)).toBe(7);
    expect(daysToDeadline(op({ deadline: '2026-06-21' }), today)).toBe(0);
    expect(daysToDeadline(op({ deadline: '2026-06-18' }), today)).toBe(-3);
    expect(daysToDeadline(op({ deadline: null }), today)).toBeNull();
  });
});

describe('isMissed', () => {
  it('flags open opportunities past deadline', () => {
    expect(isMissed(op({ deadline: '2026-06-20' }), today)).toBe(true);
    expect(isMissed(op({ deadline: '2026-06-22' }), today)).toBe(false);
  });
  it('ignores decided or undated', () => {
    expect(isMissed(op({ deadline: '2026-06-01', status: 'registered' }), today)).toBe(false);
    expect(isMissed(op({ deadline: null }), today)).toBe(false);
  });
});

describe('isClosingSoon', () => {
  it('flags open within the window and not past', () => {
    expect(isClosingSoon(op({ deadline: '2026-06-25' }), today, 7)).toBe(true);
    expect(isClosingSoon(op({ deadline: '2026-06-21' }), today, 7)).toBe(true);
    expect(isClosingSoon(op({ deadline: '2026-07-05' }), today, 7)).toBe(false);
    expect(isClosingSoon(op({ deadline: '2026-06-20' }), today, 7)).toBe(false);
  });
});

describe('urgencyBucket', () => {
  it('classifies by deadline and status', () => {
    expect(urgencyBucket(op({ status: 'registered' }), today)).toBe('done');
    expect(urgencyBucket(op({ deadline: null }), today)).toBe('no_deadline');
    expect(urgencyBucket(op({ deadline: '2026-06-19' }), today)).toBe('missed');
    expect(urgencyBucket(op({ deadline: '2026-06-25' }), today)).toBe('closing_soon');
    expect(urgencyBucket(op({ deadline: '2026-07-15' }), today)).toBe('upcoming');
  });
});

describe('groupByUrgency', () => {
  it('buckets and sorts dated groups by deadline', () => {
    const groups = groupByUrgency([
      op({ id: 'a', deadline: '2026-07-20' }),
      op({ id: 'b', deadline: '2026-07-10' }),
      op({ id: 'c', deadline: '2026-06-19' }),
      op({ id: 'd', status: 'passed', deadline: null }),
    ], today);
    expect(groups.upcoming.map((o) => o.id)).toEqual(['b', 'a']);
    expect(groups.missed.map((o) => o.id)).toEqual(['c']);
    expect(groups.done.map((o) => o.id)).toEqual(['d']);
  });
});

describe('opportunityStats', () => {
  it('summarises open/closingSoon/missed/registered', () => {
    const stats = opportunityStats([
      op({ deadline: '2026-06-25' }),                 // closing soon + open
      op({ deadline: '2026-06-19' }),                 // missed + open
      op({ deadline: '2026-08-01' }),                 // open
      op({ status: 'registered', deadline: '2026-07-01' }),
    ], today);
    expect(stats.open).toBe(3);
    expect(stats.closingSoon).toBe(1);
    expect(stats.missed).toBe(1);
    expect(stats.registered).toBe(1);
  });
});
