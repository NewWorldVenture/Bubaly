import { describe, it, expect } from 'vitest';
import {
  nextOccurrence, daysUntil, ordinal, formatCountdown, upcomingDates, isReminderDue, milestoneLabel,
  type RelDate,
} from '@/lib/relationship/dates';

// Reference "today": Friday 2026-06-26 (local).
const NOW = new Date(2026, 5, 26, 9, 0, 0);
const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];

describe('nextOccurrence', () => {
  it('rolls a recurring date forward when this year has passed', () => {
    expect(ymd(nextOccurrence('2010-03-14', true, NOW)!)).toEqual([2027, 3, 14]);
  });
  it('keeps a recurring date later this year', () => {
    expect(ymd(nextOccurrence('2010-12-25', true, NOW)!)).toEqual([2026, 12, 25]);
  });
  it('returns today when the recurring date is today', () => {
    expect(ymd(nextOccurrence('2000-06-26', true, NOW)!)).toEqual([2026, 6, 26]);
  });
  it('returns the literal date for one-offs', () => {
    expect(ymd(nextOccurrence('2026-07-04', false, NOW)!)).toEqual([2026, 7, 4]);
  });
  it('returns null for bad input', () => {
    expect(nextOccurrence('not-a-date', true, NOW)).toBeNull();
  });
});

describe('daysUntil', () => {
  it('counts whole days', () => {
    expect(daysUntil(new Date(2026, 5, 29), NOW)).toBe(3);
    expect(daysUntil(new Date(2026, 5, 26, 23), NOW)).toBe(0);
  });
});

describe('ordinal', () => {
  it('handles common and teen cases', () => {
    expect(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '23rd'])
      .toEqual([1, 2, 3, 4, 11, 12, 13, 21, 23].map(ordinal));
  });
});

describe('formatCountdown', () => {
  it('labels near-term and longer ranges', () => {
    expect(formatCountdown(0)).toBe('Today');
    expect(formatCountdown(1)).toBe('Tomorrow');
    expect(formatCountdown(3)).toBe('in 3 days');
    expect(formatCountdown(10)).toBe('in 1 week');
    expect(formatCountdown(21)).toBe('in 3 weeks');
    expect(formatCountdown(45)).toBe('in 1 month');
    expect(formatCountdown(-2)).toBe('Passed');
  });
});

const D = (over: Partial<RelDate>): RelDate => ({
  id: 'x', kind: 'custom', title: 't', eventDate: '2026-07-01', recursAnnually: true, reminderDaysBefore: 14, ...over,
});

describe('upcomingDates', () => {
  it('sorts soonest-first, drops past one-offs, computes years', () => {
    const list = upcomingDates([
      D({ id: 'anniv', kind: 'anniversary', eventDate: '2018-07-01' }),
      D({ id: 'past', kind: 'date_night', eventDate: '2026-06-01', recursAnnually: false }),
      D({ id: 'bday', kind: 'birthday', eventDate: '1990-06-29' }),
    ], { from: NOW });
    expect(list.map((d) => d.id)).toEqual(['bday', 'anniv']); // past one-off dropped
    expect(list[0].days).toBe(3);
    expect(list.find((d) => d.id === 'anniv')!.years).toBe(8);
    expect(list.find((d) => d.id === 'bday')!.years).toBe(36);
  });
  it('respects the withinDays window', () => {
    const list = upcomingDates([
      D({ id: 'soon', eventDate: '2026-06-30' }),
      D({ id: 'far', eventDate: '2026-12-30' }),
    ], { from: NOW, withinDays: 30 });
    expect(list.map((d) => d.id)).toEqual(['soon']);
  });
});

describe('isReminderDue', () => {
  it('is true inside the reminder window only', () => {
    expect(isReminderDue(D({ eventDate: '2026-06-29', reminderDaysBefore: 14 }), NOW)).toBe(true);
    expect(isReminderDue(D({ eventDate: '2026-12-30', reminderDaysBefore: 14 }), NOW)).toBe(false);
  });
});

describe('milestoneLabel', () => {
  it('labels anniversaries and birthdays', () => {
    const [anniv] = upcomingDates([D({ kind: 'anniversary', eventDate: '2018-06-29' })], { from: NOW });
    const [bday] = upcomingDates([D({ kind: 'birthday', eventDate: '1990-06-29' })], { from: NOW });
    expect(milestoneLabel(anniv)).toBe('8th anniversary');
    expect(milestoneLabel(bday)).toBe('turns 36');
  });
});
