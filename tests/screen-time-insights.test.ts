import { describe, expect, it } from 'vitest';
import {
  categoryMeta,
  formatMinutes,
  minutesOnDate,
  minutesInWindow,
  categoryBreakdown,
  balanceScore,
  limitProgress,
  underLimitStreak,
  type ScreenEntryLike,
} from '@/lib/screen-time/insights';

const e = (entry_date: string, minutes: number, category: string): ScreenEntryLike =>
  ({ member_id: 'm1', entry_date, minutes, category });

describe('categoryMeta / formatMinutes', () => {
  it('flags productive categories', () => {
    expect(categoryMeta('educational').productive).toBe(true);
    expect(categoryMeta('gaming').productive).toBe(false);
  });
  it('formats minutes', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(95)).toBe('1h 35m');
  });
});

describe('totals', () => {
  const entries = [e('2026-06-24', 30, 'gaming'), e('2026-06-24', 20, 'educational'), e('2026-06-23', 60, 'social')];
  it('minutesOnDate', () => {
    expect(minutesOnDate(entries, '2026-06-24')).toBe(50);
  });
  it('minutesInWindow', () => {
    const now = new Date('2026-06-24T12:00:00Z');
    expect(minutesInWindow(entries, 7, now)).toBe(110);
    expect(minutesInWindow(entries, 1, now)).toBe(50);
  });
});

describe('categoryBreakdown / balanceScore', () => {
  const entries = [e('2026-06-24', 30, 'gaming'), e('2026-06-24', 20, 'educational'), e('2026-06-24', 10, 'creative')];
  it('breaks down by category desc', () => {
    expect(categoryBreakdown(entries)[0]).toEqual({ category: 'gaming', minutes: 30 });
  });
  it('balance = productive / total', () => {
    expect(balanceScore(entries)).toBe(50); // (20+10)/60
    expect(balanceScore([])).toBe(100);
  });
});

describe('limitProgress', () => {
  it('computes pct + over', () => {
    expect(limitProgress(60, 120)).toEqual({ used: 60, limit: 120, pct: 50, over: false, remaining: 60 });
    expect(limitProgress(150, 120).over).toBe(true);
    expect(limitProgress(60, 0)).toEqual({ used: 60, limit: 0, pct: 0, over: false, remaining: 0 });
  });
});

describe('underLimitStreak', () => {
  it('counts days at/under the limit ending today', () => {
    const now = new Date('2026-06-24T12:00:00Z');
    const entries = [e('2026-06-24', 100, 'gaming'), e('2026-06-23', 90, 'gaming'), e('2026-06-22', 200, 'gaming')];
    expect(underLimitStreak(entries, 120, now)).toBe(2); // 24 ok, 23 ok, 22 over
    expect(underLimitStreak(entries, 0, now)).toBe(0);   // no limit
  });
});
