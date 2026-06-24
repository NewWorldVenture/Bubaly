import { describe, it, expect } from 'vitest';
import {
  toISODate, fromISODate, addDays, daysBetween, isScheduledOn,
  currentStreak, longestStreak, completionRate, heatmap, isDoneToday,
  type HabitLike,
} from '@/lib/habits/streaks';

const daily: HabitLike = { cadence: 'daily', target_per_period: 1, weekdays: [] };
const weekly: HabitLike = { cadence: 'weekly', target_per_period: 3 };

describe('date helpers', () => {
  it('round-trips ISO dates', () => {
    expect(toISODate(fromISODate('2026-06-23'))).toBe('2026-06-23');
  });
  it('adds and diffs days', () => {
    expect(addDays('2026-06-23', 5)).toBe('2026-06-28');
    expect(addDays('2026-06-01', -1)).toBe('2026-05-31');
    expect(daysBetween('2026-06-23', '2026-06-20')).toBe(3);
  });
});

describe('isScheduledOn', () => {
  it('daily with no weekday filter is always scheduled', () => {
    expect(isScheduledOn(daily, '2026-06-23')).toBe(true);
  });
  it('respects weekday filter (2026-06-23 is a Tuesday = day 2)', () => {
    expect(fromISODate('2026-06-23').getUTCDay()).toBe(2);
    expect(isScheduledOn({ ...daily, weekdays: [1, 3, 5] }, '2026-06-23')).toBe(false);
    expect(isScheduledOn({ ...daily, weekdays: [2] }, '2026-06-23')).toBe(true);
  });
});

describe('currentStreak (daily)', () => {
  const today = '2026-06-23';
  it('counts consecutive days ending today', () => {
    expect(currentStreak(daily, ['2026-06-21', '2026-06-22', '2026-06-23'], today)).toBe(3);
  });
  it('does not break when today is not yet logged', () => {
    expect(currentStreak(daily, ['2026-06-21', '2026-06-22'], today)).toBe(2);
  });
  it('breaks on a missed day', () => {
    expect(currentStreak(daily, ['2026-06-20', '2026-06-23'], today)).toBe(1);
  });
  it('is 0 with no logs', () => {
    expect(currentStreak(daily, [], today)).toBe(0);
  });
  it('skips unscheduled weekdays without breaking', () => {
    // weekdays Mon/Wed/Fri only. Today Tue is not scheduled.
    const h: HabitLike = { cadence: 'daily', target_per_period: 1, weekdays: [1, 3, 5] };
    // Fri 06-19, Mon 06-22 done; Tue 06-23 today (unscheduled) → streak walks Mon, Fri
    expect(currentStreak(h, ['2026-06-19', '2026-06-22'], today)).toBe(2);
  });
});

describe('longestStreak (daily)', () => {
  it('finds the longest consecutive run', () => {
    const logs = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-10', '2026-06-11'];
    expect(longestStreak(daily, logs)).toBe(3);
  });
  it('is 0 with no logs', () => {
    expect(longestStreak(daily, [])).toBe(0);
  });
});

describe('completionRate (daily)', () => {
  it('is hits / scheduled days in the window', () => {
    const today = '2026-06-23';
    // 4 of the last 4 days done → but window 4
    const logs = ['2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23'];
    expect(completionRate(daily, logs, today, 4)).toBe(1);
    expect(completionRate(daily, logs, today, 8)).toBe(0.5);
  });
  it('is 0 with no scheduled days', () => {
    // weekday filter that never matches the window would yield 0 scheduled → rate 0
    const h: HabitLike = { cadence: 'daily', target_per_period: 1, weekdays: [] };
    expect(completionRate(h, [], '2026-06-23', 0)).toBe(0);
  });
});

describe('weekly streaks', () => {
  it('counts a week as complete when target met', () => {
    // 2026-06-23 is in ISO week; log 3 days that week
    const logs = ['2026-06-22', '2026-06-23', '2026-06-24'];
    expect(currentStreak(weekly, logs, '2026-06-25')).toBe(1);
  });
  it('does not count a week under target', () => {
    expect(currentStreak(weekly, ['2026-06-22', '2026-06-23'], '2026-06-25')).toBe(0);
  });
});

describe('heatmap + isDoneToday', () => {
  it('produces windowDays cells ending today', () => {
    const cells = heatmap(daily, ['2026-06-23'], '2026-06-23', 7);
    expect(cells).toHaveLength(7);
    expect(cells[6]).toEqual({ date: '2026-06-23', done: true, scheduled: true });
    expect(cells[0].date).toBe('2026-06-17');
  });
  it('isDoneToday reflects a same-day log', () => {
    expect(isDoneToday(['2026-06-23'], '2026-06-23')).toBe(true);
    expect(isDoneToday(['2026-06-22'], '2026-06-23')).toBe(false);
  });
});
