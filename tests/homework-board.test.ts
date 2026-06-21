import { describe, it, expect } from 'vitest';
import {
  isOpen, isOverdue, isDueSoon, dueBucket, groupByDue, homeworkStats,
  type HomeworkLike,
} from '@/lib/homework/board';

const now = new Date('2026-06-21T12:00:00');
const hw = (over: Partial<HomeworkLike>): HomeworkLike => ({
  id: Math.random().toString(36).slice(2), due_at: null, status: 'assigned', ...over,
});

describe('isOpen', () => {
  it('is true for assigned/in_progress only', () => {
    expect(isOpen(hw({ status: 'assigned' }))).toBe(true);
    expect(isOpen(hw({ status: 'in_progress' }))).toBe(true);
    expect(isOpen(hw({ status: 'done' }))).toBe(false);
    expect(isOpen(hw({ status: 'submitted' }))).toBe(false);
  });
});

describe('isOverdue', () => {
  it('flags open homework past its due date', () => {
    expect(isOverdue(hw({ due_at: '2026-06-20T09:00:00' }), now)).toBe(true);
    expect(isOverdue(hw({ due_at: '2026-06-22T09:00:00' }), now)).toBe(false);
  });
  it('never flags completed or undated homework', () => {
    expect(isOverdue(hw({ due_at: '2026-06-01T09:00:00', status: 'done' }), now)).toBe(false);
    expect(isOverdue(hw({ due_at: null }), now)).toBe(false);
  });
});

describe('isDueSoon', () => {
  it('flags open homework within the window but not overdue', () => {
    expect(isDueSoon(hw({ due_at: '2026-06-22T12:00:00' }), now, 48)).toBe(true);
    expect(isDueSoon(hw({ due_at: '2026-06-25T12:00:00' }), now, 48)).toBe(false);
    expect(isDueSoon(hw({ due_at: '2026-06-20T12:00:00' }), now, 48)).toBe(false);
  });
});

describe('dueBucket', () => {
  it('classifies by due date and status', () => {
    expect(dueBucket(hw({ status: 'done' }), now)).toBe('done');
    expect(dueBucket(hw({ due_at: null }), now)).toBe('no_date');
    expect(dueBucket(hw({ due_at: '2026-06-20T09:00:00' }), now)).toBe('overdue');
    expect(dueBucket(hw({ due_at: '2026-06-21T20:00:00' }), now)).toBe('today');
    expect(dueBucket(hw({ due_at: '2026-06-23T09:00:00' }), now)).toBe('upcoming');
  });
});

describe('groupByDue', () => {
  it('buckets and sorts dated groups ascending', () => {
    const groups = groupByDue([
      hw({ id: 'a', due_at: '2026-06-25T09:00:00' }),
      hw({ id: 'b', due_at: '2026-06-23T09:00:00' }),
      hw({ id: 'c', due_at: '2026-06-20T09:00:00' }),
      hw({ id: 'd', status: 'done' }),
    ], now);
    expect(groups.upcoming.map((h) => h.id)).toEqual(['b', 'a']);
    expect(groups.overdue.map((h) => h.id)).toEqual(['c']);
    expect(groups.done.map((h) => h.id)).toEqual(['d']);
  });
});

describe('homeworkStats', () => {
  it('summarises open/overdue/dueSoon/completion', () => {
    const stats = homeworkStats([
      hw({ due_at: '2026-06-20T09:00:00' }),               // overdue + open
      hw({ due_at: '2026-06-22T12:00:00' }),               // due soon + open
      hw({ due_at: '2026-06-30T09:00:00' }),               // open
      hw({ status: 'submitted' }),                          // done
    ], now);
    expect(stats.open).toBe(3);
    expect(stats.overdue).toBe(1);
    expect(stats.dueSoon).toBe(1);
    expect(stats.completionRate).toBe(25);
  });
  it('returns 0 completion for empty', () => {
    expect(homeworkStats([], now).completionRate).toBe(0);
  });
});
