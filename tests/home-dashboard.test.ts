import { describe, it, expect } from 'vitest';
import { familyScore, scoreGrade } from '@/lib/home/family-score';
import {
  summarizeMonthFinances, usd, ageFromBirthday, memberTagline, weekStrip, isoDate,
} from '@/lib/home/home-data';

describe('familyScore', () => {
  it('is 100 when nothing is slipping', () => {
    const r = familyScore({ choresToday: 4, choresDone: 4, tasksOverdue: 0, overdueReminders: 0 });
    expect(r.score).toBe(100);
    expect(r.grade).toBe('A');
    expect(r.message).toMatch(/great job/i);
  });
  it('penalizes incomplete chores proportionally (max -25)', () => {
    expect(familyScore({ choresToday: 4, choresDone: 2, tasksOverdue: 0, overdueReminders: 0 }).score).toBe(88); // -12.5 → 87.5 → 88
    expect(familyScore({ choresToday: 4, choresDone: 0, tasksOverdue: 0, overdueReminders: 0 }).score).toBe(75);
  });
  it('caps task + reminder penalties', () => {
    expect(familyScore({ choresToday: 0, choresDone: 0, tasksOverdue: 99, overdueReminders: 99 }).score).toBe(55); // -25 -20
  });
  it('applies all penalties together', () => {
    // 100 − 25 (all chores missed) − 25 (tasks cap) − 20 (reminders cap) = 30
    const r = familyScore({ choresToday: 10, choresDone: 0, tasksOverdue: 99, overdueReminders: 99 });
    expect(r.score).toBe(30);
  });
  it('grades by band', () => {
    expect(scoreGrade(95)).toBe('A');
    expect(scoreGrade(82)).toBe('B');
    expect(scoreGrade(71)).toBe('C');
    expect(scoreGrade(61)).toBe('D');
    expect(scoreGrade(40)).toBe('F');
  });
});

describe('summarizeMonthFinances', () => {
  const now = new Date('2026-05-15T12:00:00Z');
  it('sums income and expenses for the current month only', () => {
    const r = summarizeMonthFinances([
      { type: 'income', amount: 6450, date: '2026-05-01' },
      { type: 'expense', amount: 3682.4, date: '2026-05-10' },
      { type: 'expense', amount: 1000, date: '2026-04-30' }, // prior month → ignored
      { type: 'transfer', amount: 500, date: '2026-05-05' }, // not income/expense
      { type: 'income', amount: 0, date: 'not-a-date' }, // bad date → ignored
    ], now);
    expect(r.income).toBe(6450);
    expect(r.expenses).toBeCloseTo(3682.4, 2);
    expect(r.remaining).toBeCloseTo(2767.6, 2);
  });
  it('treats expense magnitude regardless of sign', () => {
    expect(summarizeMonthFinances([{ type: 'expense', amount: -50, date: '2026-05-02' }], now).expenses).toBe(50);
  });
});

describe('usd', () => {
  it('formats with two decimals and separators', () => {
    expect(usd(2767.6)).toBe('$2,767.60');
    expect(usd(0)).toBe('$0.00');
  });
});

describe('ageFromBirthday', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  it('computes whole-year age', () => {
    expect(ageFromBirthday('2011-01-01', now)).toBe(15);
    expect(ageFromBirthday('2011-12-31', now)).toBe(14); // birthday not yet reached
  });
  it('returns null for missing/bad input', () => {
    expect(ageFromBirthday(null, now)).toBeNull();
    expect(ageFromBirthday('nope', now)).toBeNull();
  });
});

describe('memberTagline', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  it('says Me for the current user', () => {
    expect(memberTagline({ user_id: 'u1', role: 'parent', birthday: null }, 'u1', now)).toBe('Me');
  });
  it('shows age for young members', () => {
    expect(memberTagline({ user_id: null, role: 'child', birthday: '2018-01-01' }, 'u1', now)).toBe('8 yrs');
  });
  it('falls back to a short role label', () => {
    expect(memberTagline({ user_id: 'u2', role: 'adult', birthday: null }, 'u1', now)).toBe('Adult');
    expect(memberTagline({ user_id: 'u3', role: 'parent', birthday: '1985-01-01' }, 'u1', now)).toBe('Parent');
  });
});

describe('weekStrip', () => {
  it('returns Mon→Sun with today flagged', () => {
    const now = new Date('2026-05-14T09:00:00'); // a Thursday (local)
    const days = weekStrip(now);
    expect(days).toHaveLength(7);
    expect(days[0].dow).toBe('Mon');
    expect(days[6].dow).toBe('Sun');
    const today = days.find((d) => d.isToday);
    expect(today?.date).toBe(isoDate(now));
    expect(today?.dow).toBe('Thu');
  });
});
